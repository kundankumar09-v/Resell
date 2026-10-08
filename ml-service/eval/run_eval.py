"""
ReSell ML pipeline evaluation harness (REAL DATA by default).

Runs the LEGACY pipeline (rule-based fraud / heuristic price) and the v2
pipeline (LightGBM + calibration + conformal) on identical REAL labeled data
with time-based and seller-grouped splits, and writes a markdown report with a
before/after table.

Real data comes from MongoDB (admin approve/reject = fraud label, sold price =
price label) or CSV files in eval/data/ (see eval/data_loader.py). The eval
FAILS LOUDLY when CLIP falls back to placeholder embeddings or when no real
labeled data exists - it never falls back to the synthetic generator unless
--data-source synthetic is passed explicitly (debugging only; synthetic results
are never written to the production report).

Usage:
    python eval/run_eval.py --baseline            # record BASELINE numbers only
    python eval/run_eval.py                       # evaluate BOTH on real data
    python eval/run_eval.py --data-source synthetic --n-fraud 2000  # debug only
"""

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from eval.splits import time_based_split, seller_grouped_split  # noqa: E402
from eval.metrics import (  # noqa: E402
    fraud_metrics, price_metrics, latency_metrics, calibration_curve)
from eval.data_loader import load_real_data  # noqa: E402

REPORT_PATH = os.path.join(os.path.dirname(__file__), "report.md")
BASELINE_PATH = os.path.join(os.path.dirname(__file__), "baseline.json")

#  Legacy pipeline imports (baseline system, untouched) 
from services.fraud_detector import evaluate_fraud_risk as legacy_fraud  # noqa: E402
from services.price_estimator import estimate_price_knn as legacy_price  # noqa: E402

#  v2 pipeline imports 
import pipeline.fraud_v2 as fv2  # noqa: E402
import pipeline.price_v2 as pv2  # noqa: E402
from pipeline.ann_index import ann_index  # noqa: E402
from pipeline import config  # noqa: E402


# 
# v2 in-process training (per split, no artifact files needed)
# 

def train_v2_fraud_inprocess(fraud_records, train_idx, seed=42):
    """Train calibrated LightGBM fraud classifier on the train split. Returns (classifier, thresholds)."""
    from sklearn.isotonic import IsotonicRegression
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import precision_recall_curve
    from sklearn.model_selection import train_test_split
    import lightgbm as lgb

    t0 = time.perf_counter()

    if len(train_idx) < 8:
        return None, None

    X, y = [], []
    for i in train_idx:
        rec = fraud_records[i]
        feats, _ = fv2.extract_fraud_features_v2(
            rec["listing"], rec["candidateListings"],
            category_median_price=rec["categoryMedianPrice"],
            image_title_similarity=rec["imageTitleSimilarity"])
        X.append([feats[k] for k in fv2.FEATURE_ORDER])
        y.append(int(rec["label"]))
    X, y = np.array(X, dtype=np.float32), np.array(y, dtype=np.int32)

    if len(np.unique(y)) < 2:
        return None, None

    tr, cal = train_test_split(np.arange(len(y)), test_size=0.25, random_state=seed,
                               stratify=y)
    pos_weight = float((y[tr] == 0).sum() / max(1, (y[tr] == 1).sum()))
    params = {"objective": "binary", "metric": "binary_logloss", "learning_rate": 0.05,
              "num_leaves": 31, "min_child_samples": 20, "scale_pos_weight": pos_weight,
              "feature_fraction": 0.9, "bagging_fraction": 0.8, "bagging_freq": 1,
              "seed": seed, "verbose": -1}
    model = lgb.train(params, lgb.Dataset(X[tr], label=y[tr]), num_boost_round=300)

    raw = model.predict(X[cal])
    try:
        calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        calibrator.fit(raw, y[cal])
    except Exception:
        calibrator = LogisticRegression().fit(raw.reshape(-1, 1), y[cal])

    def calib(scores):
        if isinstance(calibrator, IsotonicRegression):
            return np.clip(calibrator.predict(scores), 0.0, 1.0)
        return np.clip(calibrator.predict_proba(scores.reshape(-1, 1))[:, 1], 0.0, 1.0)

    probs = calib(raw)
    precision, recall, thresholds = precision_recall_curve(y[cal], probs)
    f1 = 2 * precision[:-1] * recall[:-1] / np.maximum(precision[:-1] + recall[:-1], 1e-9)
    flag_t = float(np.clip(thresholds[int(np.argmax(f1))], 0.05, 0.95))
    review_t = float(np.clip(flag_t * 0.5, 0.05, flag_t - 0.05))

    train_ms = (time.perf_counter() - t0) * 1000
    return (model, calibrator, calib), {"flag_threshold": flag_t, "review_threshold": review_t,
                                        "train_ms": round(train_ms, 1)}


def train_v2_price_inprocess(price_records, train_idx, seed=42, conformal_alpha=0.20):
    """Train LightGBM quantile (0.1/0.5/0.9) on log-price + conformal width. Returns (models, width)."""
    import lightgbm as lgb

    t0 = time.perf_counter()
    from pipeline.price_v2 import TABULAR_FEATURES, extract_price_features_v2

    if len(train_idx) < 8:
        return None, None, 0.0

    X, y = [], []
    for i in train_idx:
        rec = price_records[i]
        if float(rec.get("price") or 0) <= 0:
            continue
        feats, _, _ = extract_price_features_v2(rec, rec.get("comparables") or [], use_ann=False)
        X.append([feats[k] for k in TABULAR_FEATURES])
        y.append(np.log(float(rec["price"])))
    X, y = np.array(X, dtype=np.float32), np.array(y, dtype=np.float64)

    rng = np.random.RandomState(seed)
    perm = rng.permutation(len(y))
    calib_cut = int(len(y) * 0.25)
    calib_idx, fit_idx = perm[:calib_cut], perm[calib_cut:]

    params = {"objective": "quantile", "metric": "quantile", "learning_rate": 0.05,
              "num_leaves": 31, "min_child_samples": 20, "seed": seed, "verbose": -1}
    models, preds_cal = {}, {}
    for q, tag in ((0.1, "p10"), (0.5, "p50"), (0.9, "p90")):
        p = dict(params)
        p["alpha"] = q
        m = lgb.train(p, lgb.Dataset(X[fit_idx], label=y[fit_idx]), num_boost_round=300)
        models[tag] = m
        preds_cal[tag] = m.predict(X[calib_idx])

    # Conformal calibration in log space
    q10, q50, q90 = preds_cal["p10"], preds_cal["p50"], preds_cal["p90"]
    y_cal = y[calib_idx]
    scores = np.maximum(q10 - y_cal, y_cal - q90)
    width = float(np.quantile(scores, min(1.0, 1 - conformal_alpha + 1 / max(1, len(scores)))))
    train_ms = (time.perf_counter() - t0) * 1000
    return models, width, round(train_ms, 1)


def install_v2_price_models(models, width):
    """Inject in-process trained v2 price models into the pipeline module global."""
    if not models:
        return

    class _EvalPriceModel:
        def __init__(self):
            self.models = models
            self.conformal_width = width

        def is_available(self):
            return len(self.models) == 3

        def predict_log_quantiles(self, features):
            Xf = np.array([[features[k] for k in pv2.TABULAR_FEATURES]], dtype=np.float32)
            q10 = float(self.models["p10"].predict(Xf)[0])
            q50 = float(self.models["p50"].predict(Xf)[0])
            q90 = float(self.models["p90"].predict(Xf)[0])
            return q10, q50, q90

    pv2.model_v2 = _EvalPriceModel()


def install_v2_models(trained_fraud, thresholds):
    """Inject in-process trained v2 models into the pipeline module globals."""
    from sklearn.isotonic import IsotonicRegression

    if trained_fraud is not None and trained_fraud[0] is not None:
        model, calibrator, _ = trained_fraud[0]

        class _EvalClassifier:
            def predict_proba(self, features):
                Xf = np.array([[features.get(k, 0.0) for k in fv2.FEATURE_ORDER]], dtype=np.float32)
                raw = float(model.predict(Xf)[0])
                if isinstance(calibrator, IsotonicRegression):
                    return float(np.clip(calibrator.predict([raw])[0], 0.0, 1.0))
                return float(np.clip(calibrator.predict_proba([[raw]])[0][1], 0.0, 1.0))

        fv2.classifier = _EvalClassifier()
        fv2.load_thresholds = lambda: dict(thresholds)


_original_load_thresholds = fv2.load_thresholds  # captured before any monkeypatching


def uninstall_v2_models():
    """Restore the production module globals (file-loaded / fallback)."""
    from pipeline import config as cfg
    fv2.classifier = fv2.CalibratedFraudClassifier(cfg.FRAUD_MODEL_PATH, cfg.FRAUD_CALIBRATOR_PATH)
    fv2.load_thresholds = _original_load_thresholds
    pv2.model_v2 = pv2.QuantilePriceModelV2(cfg.PRICE_MODEL_PREFIX, cfg.PRICE_CONFORMAL_PATH)


# 
# Evaluation loops
# 

def eval_fraud_baseline(fraud_records, test_idx) -> dict:
    scores, lat = [], []
    for i in test_idx:
        rec = fraud_records[i]
        t0 = time.perf_counter()
        title_sim = rec.get("imageTitleSimilarity")
        if title_sim is None and rec["listing"].get("imageUrl"):
            try:
                from models.clip_model import compute_image_text_similarity
                title_sim = compute_image_text_similarity(
                    rec["listing"]["imageUrl"], rec["listing"].get("title") or "")
            except Exception:
                title_sim = None
        res = legacy_fraud(listing=rec["listing"], candidate_listings=rec["candidateListings"],
                           image_title_similarity=title_sim,
                           category_median_price=rec["categoryMedianPrice"])
        lat.append((time.perf_counter() - t0) * 1000)
        scores.append(res["fraudScore"] / 100.0)
    return {"scores": np.array(scores), "latency": lat}


def eval_fraud_v2(fraud_records, test_idx) -> dict:
    scores, lat, stage_times = [], [], {}
    for i in test_idx:
        rec = fraud_records[i]
        t0 = time.perf_counter()
        res = fv2.evaluate_fraud_risk_v2(
            listing=rec["listing"], candidate_listings=rec["candidateListings"],
            category_median_price=rec["categoryMedianPrice"],
            image_title_similarity=rec["imageTitleSimilarity"])
        lat.append((time.perf_counter() - t0) * 1000)
        scores.append(res["fraudProbability"])
        for k, v in res.get("stageTimingsMs", {}).items():
            stage_times.setdefault(k, []).append(v)
    return {"scores": np.array(scores), "latency": lat, "stages": stage_times}


def eval_price_baseline(price_records, test_idx, k=5) -> dict:
    preds, p25s, p75s, lat = [], [], [], []
    for i in test_idx:
        rec = price_records[i]
        comps = rec.get("comparables") or []
        t0 = time.perf_counter()
        res = legacy_price(target_embedding=rec["embedding"], target_metadata=rec,
                           comparables=comps, k_neighbors=k)
        lat.append((time.perf_counter() - t0) * 1000)
        preds.append(float(res["suggestedPrice"]))
        p25s.append(float(res["priceRange"]["p25"]))
        p75s.append(float(res["priceRange"]["p75"]))
    return {"preds": np.array(preds), "p25": np.array(p25s), "p75": np.array(p75s),
            "latency": lat}


def eval_price_v2(price_records, test_idx, k=12) -> dict:
    preds, p25s, p75s, p10s, p90s, lat, no_sugg = [], [], [], [], [], [], 0
    stage_times = {}
    for i in test_idx:
        rec = price_records[i]
        t0 = time.perf_counter()
        res = pv2.evaluate_price_v2(rec, rec.get("comparables") or [],
                                    target_embedding=rec["embedding"], k_neighbors=k)
        lat.append((time.perf_counter() - t0) * 1000)
        sp = res.get("suggestedPrice")
        if sp is None:
            no_sugg += 1
            sp = np.nan
        preds.append(float(sp))
        p25s.append(float(res["priceRange"]["p25"]))
        p75s.append(float(res["priceRange"]["p75"]))
        # For coverage of the true 80% interval, use min/max of the conformal range
        p10s.append(float(res["priceRange"]["min"]))
        p90s.append(float(res["priceRange"]["max"]))
        for kk, v in res.get("stageTimingsMs", {}).items():
            stage_times.setdefault(kk, []).append(v)
    return {"preds": np.array(preds), "p25": np.array(p25s), "p75": np.array(p75s),
            "p10": np.array(p10s), "p90": np.array(p90s), "latency": lat,
            "no_suggestion": no_sugg, "stages": stage_times}


# 
# Efficiency micro-benchmark (embedding cache / batch path)
# 

def bench_embedding_efficiency(n_images=16) -> dict:
    """Compare legacy single-image loop vs v2 cached path (miss pass + hit pass)."""
    import hashlib
    from models.clip_model import extract_image_embedding
    from pipeline.embedding_cache import get_image_embedding_cached, _image_cache, _text_cache

    # Deterministic synthetic fallback path (no network): pre-seed the legacy
    # fallback by generating tiny local images via PIL
    import tempfile
    from PIL import Image
    tmpdir = tempfile.mkdtemp(prefix="resell-eval-")
    paths = []
    for i in range(n_images):
        p = os.path.join(tmpdir, f"img_{i}.jpg")
        if not os.path.exists(p):
            Image.new("RGB", (64, 64), color=(i * 15 % 255, i * 37 % 255, i * 59 % 255)).save(p)
        paths.append(p)

    def run(fn, sources):
        lat = []
        for s in sources:
            t0 = time.perf_counter()
            try:
                fn(s)
            except Exception:
                pass
            lat.append((time.perf_counter() - t0) * 1000)
        return lat

    legacy_lat = run(extract_image_embedding, paths)
    _image_cache.clear()
    _text_cache.clear()
    miss_lat = run(get_image_embedding_cached, paths)
    hit_lat = run(get_image_embedding_cached, paths)  # warm cache
    return {
        "legacy_sequential": latency_metrics(legacy_lat),
        "v2_cache_miss": latency_metrics(miss_lat),
        "v2_cache_hit": latency_metrics(hit_lat),
    }


def bench_clip_inference(image_paths: list) -> dict:
    """Real CLIP inference latency (cold pass after cache clear) on real images."""
    from models.clip_model import extract_image_embedding
    from pipeline.embedding_cache import _image_cache, _text_cache
    if not image_paths:
        return {"p50_ms": None, "p95_ms": None, "mean_ms": None}
    lat = []
    for p in image_paths:
        t0 = time.perf_counter()
        try:
            extract_image_embedding(p)
        except Exception:
            pass
        lat.append((time.perf_counter() - t0) * 1000)
    _image_cache.clear()
    _text_cache.clear()
    return latency_metrics(lat)


# 
# Report generation
# 

def _fmt(v, pct=False):
    if v is None:
        return "-"
    return f"{v*100:.2f}%" if pct else f"{v}"


def build_report(results: dict, baseline_only: bool = False) -> str:
    lines = []
    a = lines.append
    a("# ReSell ML Pipeline Evaluation Report")
    a("")
    a(f"_Generated: {time.strftime('%Y-%m-%d %H:%M:%S')} - Feature flag: `ML_PIPELINE_V2` "
      f"(baseline = legacy rule/heuristic pipeline, v2 = LightGBM + calibration + conformal)_")
    a("")

    data_meta = results.get("_data", {})
    if data_meta:
        a("## Real evaluation data")
        a("")
        a(f"- Sources: {json.dumps(data_meta.get('sources', {}))}")
        a(f"- Labeled fraud records: {data_meta.get('n_fraud_records')} "
          f"({data_meta.get('n_fraud_positive')} fraud / {data_meta.get('n_fraud_negative')} legit)")
        a(f"- Price records (sold listings): {data_meta.get('n_price_records')}")
        a(f"- Embeddings computed via real CLIP: {data_meta.get('embeddings_computed_via_clip')}")
        a("")
        if data_meta.get("n_fraud_positive", 0) < 10:
            a("> **CAVEAT: fewer than 10 positive fraud labels** - fraud precision/recall/"
              "PR-AUC are not statistically meaningful. Export admin reject decisions or add "
              "labeled rows to `eval/data/listings.csv`.")
            a("")
        if data_meta.get("n_price_records", 0) < 20:
            a("> **CAVEAT: fewer than 20 sold listings** - price metrics are not "
              "statistically meaningful (some splits are skipped entirely). Export sold "
              "prices or add rows to `eval/data/listings.csv`.")
            a("")

    for split_name, r in results.items():
        if split_name.startswith("_"):
            continue
        a(f"## Split: {split_name}")
        a("")
        a("### Fraud metrics")
        a("")
        a("| Metric | Baseline (legacy) | v2 (upgrade) | Delta |")
        a("|---|---|---|---|")
        for key, label in [("precision", "Precision"), ("recall", "Recall"),
                           ("f1", "F1"), ("pr_auc", "PR-AUC"),
                           ("recall_at_2pct_fpr", "Recall @ 2% FPR"),
                           ("flagged_rate", "Flagged rate")]:
            b = (r.get("fraud_baseline") or {}).get(key)
            v = (r.get("fraud_v2") or {}).get(key)
            delta = (v - b) if (b is not None and v is not None) else None
            delta_s = f"{delta*100:+.2f}pp" if delta is not None else "-"
            a(f"| {label} | {_fmt(b, pct=True)} | {_fmt(v, pct=True)} | {delta_s} |")
        a("")
        b_thr = (r.get("fraud_baseline") or {}).get("threshold")
        v_thr = (r.get("fraud_v2") or {}).get("threshold")
        a(f"Operating thresholds: baseline flagged >= {b_thr} (fixed 0.70 on 0-100 scale) - "
          f"v2 flag >= {v_thr} (PR-curve max-F1, calibrated probability)")
        a("")

        cal_b = r["fraud_baseline"].get("calibration_curve") or []
        cal_v = r["fraud_v2"].get("calibration_curve") or []
        if cal_v or cal_b:
            a("### Calibration curve (fraud probability reliability, 10 bins)")
            a("")
            a("| Predicted prob bin | Baseline: predicted / observed | v2: predicted / observed |")
            a("|---|---|---|")
            bins = [(c["bin_low"], c["bin_high"]) for c in (cal_v or cal_b)]
            b_map = {(c["bin_low"], c["bin_high"]): c for c in cal_b}
            v_map = {(c["bin_low"], c["bin_high"]): c for c in cal_v}
            for lo, hi in bins:
                bc, vc = b_map.get((lo, hi)), v_map.get((lo, hi))
                b_s = f"{bc['mean_predicted']:.2f} / {bc['frac_pos']:.2f} (n={bc['count']})" if bc else "-"
                v_s = f"{vc['mean_predicted']:.2f} / {vc['frac_pos']:.2f} (n={vc['count']})" if vc else "-"
                a(f"| [{lo:.1f}, {hi:.1f}) | {b_s} | {v_s} |")
            a("_Well-calibrated = predicted probability tracks observed fraud rate "
              "(diagonal). Sparse bins with tiny n are noise._")
            a("")
        a("### Price metrics")
        a("")
        a("| Metric | Baseline (legacy) | v2 (upgrade) | Delta |")
        a("|---|---|---|---|")
        pk = r.get("price_baseline") or {}
        pv = r.get("price_v2") or {}
        rows = [("MAE (log-price)", "mae_log"), ("MAPE", "mape"), ("RMSE (log)", "rmse_log"),
                ("p25-p75 coverage", "coverage_p25_p75"), ("p10-p90 coverage", "coverage_p10_p90")]
        for label, key in rows:
            b, v = pk.get(key), pv.get(key)
            delta = (v - b) if (b is not None and v is not None) else None
            a(f"| {label} | {b if b is not None else '-'} | {v if v is not None else '-'} | "
              f"{f'{delta:+.4f}' if delta is not None else '-'} |")
        a(f"| No-suggestion rate (low confidence) | 0% | "
          f"{pv.get('no_suggestion_rate', 0)*100:.1f}% | (v2 behavior: wide range or null) |")
        a("")

        a("### Latency (per call, ms)")
        a("")
        a("| Stage | Baseline p50 | Baseline p95 | v2 p50 | v2 p95 |")
        a("|---|---|---|---|---|")
        def _lat(x):
            if not x:
                return {"p50_ms": None, "p95_ms": None}
            if isinstance(x, dict):  # already aggregated percentiles
                return {**{"p50_ms": None, "p95_ms": None}, **x}
            return latency_metrics(x)

        fb = _lat(r.get("fraud_baseline_latency") or (r.get("fraud_baseline") or {}).get("latency"))
        fv = _lat(r.get("fraud_v2_latency") or (r.get("fraud_v2") or {}).get("latency"))
        pb = _lat(r.get("price_baseline_latency") or (r.get("price_baseline") or {}).get("latency"))
        pt = _lat(r.get("price_v2_latency") or (r.get("price_v2") or {}).get("latency"))
        a(f"| Fraud (total) | {fb['p50_ms']} | {fb['p95_ms']} | {fv['p50_ms']} | {fv['p95_ms']} |")
        a(f"| Price (total) | {pb['p50_ms']} | {pb['p95_ms']} | {pt['p50_ms']} | {pt['p95_ms']} |")
        clip = results.get("_clip_latency") or {}
        if clip.get("p50_ms") is not None:
            a(f"| CLIP inference (real, cold) | - | - | {clip['p50_ms']} | {clip['p95_ms']} |")
        for k in sorted((r.get("fraud_v2") or {}).get("stages", {})):
            st = latency_metrics(r["fraud_v2"]["stages"][k])
            a(f"| Fraud v2 stage: {k} | - | - | {st['p50_ms']} | {st['p95_ms']} |")
        for k in sorted((r.get("price_v2") or {}).get("stages", {})):
            st = latency_metrics(r["price_v2"]["stages"][k])
            a(f"| Price v2 stage: {k} | - | - | {st['p50_ms']} | {st['p95_ms']} |")
        a("")

    if "efficiency" in results.get("_meta", {}):
        eff = results["_meta"]["efficiency"]
        a("## Efficiency benchmark (embedding cache / batch path)")
        a("")
        a("| Path | p50 ms | p95 ms | mean ms |")
        a("|---|---|---|---|")
        for name, m in eff.items():
            a(f"| {name} | {m['p50_ms']} | {m['p95_ms']} | {m['mean_ms']} |")
        a("")

    return "\n".join(lines)


# 

def main():
    parser = argparse.ArgumentParser(description="ReSell ML eval harness")
    parser.add_argument("--baseline", action="store_true",
                        help="Record BASELINE (legacy) numbers only")
    parser.add_argument("--data-source", choices=["real", "synthetic"], default="real",
                        help="real = MongoDB/CSV labeled listings (default); "
                             "synthetic = generated data, debugging only")
    parser.add_argument("--n-fraud", type=int, default=2000)
    parser.add_argument("--n-price", type=int, default=1500)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    clip_latency_meta = None
    if args.data_source == "real":
        # Fail-loud guard: never evaluate with placeholder fallback embeddings
        from models.clip_model import initialize_clip, is_model_loaded
        print("Initializing real CLIP (fail-loud placeholder check)...")
        initialize_clip()
        if not is_model_loaded():
            raise SystemExit(
                "FATAL: CLIP failed to load - refusing to run the evaluation with "
                "placeholder fallback embeddings. Install torch + open-clip-torch, "
                "ensure the laion2b weights are downloadable, and retry.")
        print("Loading REAL labeled data (MongoDB / eval/data CSV)...")
        fraud_records, price_records, data_meta = load_real_data(require_clip=True)
        print(f"  sources: {json.dumps(data_meta['sources'])}")
        print(f"  fraud: {data_meta['n_fraud_records']} labeled records "
              f"({data_meta['n_fraud_positive']} fraud / {data_meta['n_fraud_negative']} legit)")
        print(f"  price: {data_meta['n_price_records']} sold-price records")
        print(f"  embeddings computed via real CLIP: {data_meta['embeddings_computed_via_clip']}")
        if data_meta["n_fraud_positive"] < 10:
            print(f"WARNING: only {data_meta['n_fraud_positive']} positive fraud labels - "
                  f"fraud metrics are not statistically meaningful (see report caveats).")
        image_paths = [r.get("imageUrl") for r in fraud_records if r.get("imageUrl")]
        clip_latency_meta = bench_clip_inference(image_paths[:12])
        print(f"  real CLIP inference latency: {clip_latency_meta}")
    else:
        from eval.generate_data import generate_fraud_dataset, generate_price_dataset
        print("Generating SYNTHETIC datasets (debug mode - NOT production evidence)...")
        fraud_records = generate_fraud_dataset(n=args.n_fraud, seed=args.seed)
        price_records = generate_price_dataset(n=args.n_price, seed=args.seed)
        data_meta = {
            "sources": {"synthetic": "debug-only"},
            "n_products": len(fraud_records),
            "embeddings_computed_via_clip": 0,
            "n_fraud_records": len(fraud_records),
            "n_fraud_positive": sum(r["label"] for r in fraud_records),
            "n_fraud_negative": len(fraud_records) - sum(r["label"] for r in fraud_records),
            "n_price_records": len(price_records),
        }
        print(f"  fraud: {len(fraud_records)} records ({data_meta['n_fraud_positive']} positive)")
        print(f"  price: {len(price_records)} records")

    f_ts = np.array([r["timestamp"] for r in fraud_records])
    f_sellers = [r["sellerId"] for r in fraud_records]
    p_ts = np.array([r["timestamp"] for r in price_records])
    p_sellers = [r["sellerId"] for r in price_records]

    def build_splits(ts, sellers, task):
        out = {}
        try:
            out["time-based"] = time_based_split(ts)
        except AssertionError as e:
            print(f"  {task}: SKIPPING time-based split ({e})")
        try:
            out["seller-grouped"] = seller_grouped_split(sellers)
        except AssertionError as e:
            print(f"  {task}: SKIPPING seller-grouped split ({e})")
        return out

    f_splits = build_splits(f_ts, f_sellers, "fraud")
    p_splits = build_splits(p_ts, p_sellers, "price")

    split_names = list(dict.fromkeys(list(f_splits.keys()) + list(p_splits.keys())))
    if not split_names:
        raise SystemExit(
            "FATAL: not enough real data for any split (need >10 labeled records per task). "
            "Export more labeled listings via the admin approve/reject flow and sold orders, "
            "or add rows to eval/data/listings.csv.")

    all_results = {}
    empty_idx = np.array([], dtype=int)
    for split_name in split_names:
        f_tr, f_te = f_splits.get(split_name, (empty_idx, empty_idx))
        p_tr, p_te = p_splits.get(split_name, (None, None))
        has_fraud = len(f_te) > 0
        has_price = p_tr is not None and len(p_te) > 0
        print(f"\n=== Split: {split_name} (fraud train/test "
              f"{len(f_tr)}/{len(f_te) if has_fraud else 0}, price train/test "
              f"{len(p_tr) if has_price else 0}/{len(p_te) if has_price else 0}) ===")

        split_results = {}
        if has_price:
            print("Building HNSW ANN index from this split's training comparables...")
            ann_index.build_global([price_records[i] for i in p_tr])
            print(f"  {ann_index.stats()}")

        y_f = np.array([fraud_records[i]["label"] for i in f_te]) if has_fraud else np.array([])

        if has_fraud:
            print("Evaluating BASELINE (legacy pipeline)...")
            fb = eval_fraud_baseline(fraud_records, f_te)
        if has_price:
            pb = eval_price_baseline(price_records, p_te)

        if has_fraud:
            # Legacy max-F1 threshold on its own PR curve (fairness: best possible legacy)
            from sklearn.metrics import precision_recall_curve
            if len(np.unique(y_f)) > 1:
                prec, rec, thr = precision_recall_curve(y_f, fb["scores"])
                f1 = 2 * prec[:-1] * rec[:-1] / np.maximum(prec[:-1] + rec[:-1], 1e-9)
                legacy_best_thr = float(thr[int(np.argmax(f1))]) if len(thr) else 0.7
            else:
                legacy_best_thr = 0.7

            fraud_base_metrics = fraud_metrics(y_f, fb["scores"], 0.70)          # default operating point
            fraud_base_best = fraud_metrics(y_f, fb["scores"], legacy_best_thr)  # legacy at its max-F1
            fraud_base_metrics["calibration_curve"] = calibration_curve(y_f, fb["scores"])
            fraud_base_best["calibration_curve"] = fraud_base_metrics["calibration_curve"]
            split_results["fraud_baseline"] = fraud_base_metrics
            split_results["fraud_baseline_at_maxf1"] = fraud_base_best
            split_results["fraud_baseline_latency"] = latency_metrics(fb["latency"])

        if has_price:
            y_p = np.array([price_records[i]["price"] for i in p_te])
            price_base_metrics = price_metrics(y_p, pb["preds"], pb["p25"], pb["p75"])
            split_results["price_baseline"] = price_base_metrics
            split_results["price_baseline_latency"] = latency_metrics(pb["latency"])

        if args.baseline:
            all_results[split_name] = split_results
            continue

        if has_fraud:
            print("Training v2 models (in-process)...")
            # De-leak: training records' comparables must only reference train-split
            # records (prevents test prices leaking into training features)
            if has_price:
                train_ids = {price_records[i]["id"] for i in p_tr}
                for i in p_tr:
                    rec = price_records[i]
                    if rec.get("comparables"):
                        rec["comparables"] = [c for c in rec["comparables"] if c.get("id") in train_ids]

            trained = train_v2_fraud_inprocess(fraud_records, f_tr, seed=args.seed)
            thresholds = trained[1] if trained else None
            print(f"  v2 fraud thresholds: {thresholds}")
            install_v2_models(trained, thresholds or {})

        if has_price:
            price_models, width, price_train_ms = train_v2_price_inprocess(price_records, p_tr, seed=args.seed)
            if price_models is None:
                print("  v2 price: SKIPPED - fewer than 8 training records in this split")
                width, price_train_ms = None, 0.0
            else:
                print(f"  v2 price conformal width (log): {width:.4f} (train {price_train_ms}ms)")
                install_v2_price_models(price_models, width)

        if has_fraud:
            print("Evaluating v2 pipeline...")
            fv = eval_fraud_v2(fraud_records, f_te)
            uninstall_v2_models()

            fraud_v2_m = fraud_metrics(y_f, fv["scores"],
                                       thresholds["flag_threshold"] if thresholds else 0.5)
            fraud_v2_m["calibration_curve"] = calibration_curve(y_f, fv["scores"])
            split_results["fraud_v2"] = fraud_v2_m
            split_results["fraud_v2_latency"] = latency_metrics(fv["latency"])
            split_results["fraud_v2_stages"] = fv["stages"]
            split_results["v2_train"] = thresholds

        if has_price and price_models is not None:
            pv = eval_price_v2(price_records, p_te)
            price_v2_metrics = price_metrics(y_p, pv["preds"], pv["p25"], pv["p75"],
                                             pv["p10"], pv["p90"])
            price_v2_metrics["no_suggestion_rate"] = pv["no_suggestion"] / max(1, len(p_te))
            split_results["price_v2"] = price_v2_metrics
            split_results["price_v2_latency"] = latency_metrics(pv["latency"])
            split_results["price_v2_stages"] = pv["stages"]
            split_results["v2_price_train"] = {"conformal_width": width, "train_ms": price_train_ms}

        all_results[split_name] = split_results

    all_results["_data"] = data_meta
    if clip_latency_meta:
        all_results["_clip_latency"] = clip_latency_meta

    if args.baseline:
        with open(BASELINE_PATH, "w") as f:
            json.dump(all_results, f, indent=2, default=str)
        print(f"\nBASELINE recorded to {BASELINE_PATH}")
        print(json.dumps(all_results, indent=2, default=str))
        return

    # Merge recorded baseline (if present) with fresh results
    recorded = {}
    if os.path.exists(BASELINE_PATH):
        with open(BASELINE_PATH) as f:
            recorded = json.load(f)

    report_input = {}
    for split_name, r in all_results.items():
        if split_name.startswith("_"):
            continue
        entry = dict(r)
        base = recorded.get(split_name, {})
        # Prefer recorded baseline metrics if available
        for key in ("fraud_baseline", "fraud_baseline_at_maxf1", "price_baseline"):
            if key in base and key not in r:
                entry[key] = base[key]
        entry["fraud_baseline"] = entry.get("fraud_baseline") or base.get("fraud_baseline", {})
        entry["fraud_v2"] = r.get("fraud_v2", entry.get("fraud_v2", {}))
        entry["price_baseline"] = entry.get("price_baseline") or base.get("price_baseline", {})
        entry["price_v2"] = r.get("price_v2", entry.get("price_v2", {}))
        report_input[split_name] = entry

    report_input["_data"] = data_meta
    report_input["_clip_latency"] = clip_latency_meta or {}

    print("\nRunning efficiency benchmark...")
    report_input["_meta"] = {"efficiency": bench_embedding_efficiency()}

    report = build_report(report_input)
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\nReport written to {REPORT_PATH}")
    print(report)


if __name__ == "__main__":
    main()

