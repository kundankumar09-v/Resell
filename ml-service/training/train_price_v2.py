"""
Training Script v2: LightGBM Quantile Regression (0.1/0.5/0.9) on log-price
with kNN-median + neighbor-spread features and conformal interval calibration.

Improvements over training/train_price_model.py:
- Trains on LOG-price (multiplicative errors become additive).
- Quantiles 0.1/0.5/0.9 (was 0.25/0.50/0.75) for a true 80% interval.
- kNN-median + spread features from comparables (HNSW at inference time).
- Conformal calibration of interval widths on a holdout split.
- Saves: price_v2_{p10,p50,p90}.txt, price_v2_conformal.json.
"""

import os
import json
import argparse
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _refuse_synthetic_to_production(output_dir: str, data_source: str):
    """
    Guard: model artifacts trained on SYNTHETIC data (eval/generate_data.py)
    must never be written into the production models directory. They only
    prove rule-recovery of the generator, not real-world performance.
    """
    if data_source != "synthetic":
        return
    from pipeline import config
    if (os.path.realpath(os.path.abspath(output_dir))
            == os.path.realpath(os.path.abspath(config.MODEL_DIR))):
        raise SystemExit(
            "REFUSING TO SAVE: these artifacts were trained on SYNTHETIC data and "
            f"the output directory is the production models dir ({os.path.realpath(config.MODEL_DIR)}). "
            "Train on real labeled data (MongoDB sold prices, prediction-log feedback "
            "via training/retrain.py, or CSV via eval/data_loader.py), or pass --output "
            "pointing at a non-production directory for debugging.")


def _load_dataset(data_path: str):
    records = []
    data_source = "file"
    if os.path.exists(data_path):
        with open(data_path, "r", encoding="utf-8") as f:
            first = f.read(1)
            f.seek(0)
            if first == "[":
                records = json.load(f)
            else:
                for line in f:
                    line = line.strip()
                    if line:
                        records.append(json.loads(line))
    else:
        print(f"Dataset not found at {data_path}; generating synthetic sold listings...")
        from eval.generate_data import generate_price_dataset
        records = generate_price_dataset(n=1500, seed=42)
        data_source = "synthetic"
    for rec in records:
        if rec.get("synthetic"):
            data_source = "synthetic"
    return records, data_source


def _build_features(records):
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from pipeline.price_v2 import extract_price_features_v2, TABULAR_FEATURES

    X, y, timestamps, seller_ids = [], [], [], []
    for rec in records:
        price = float(rec.get("price") or rec.get("soldPrice") or 0)
        if price <= 0:
            continue
        feats, _, _ = extract_price_features_v2(rec, rec.get("comparables") or [], use_ann=False)
        X.append([feats[k] for k in TABULAR_FEATURES])
        y.append(np.log(price))
        timestamps.append(float(rec.get("timestamp") or rec.get("createdAt") or 0))
        seller_ids.append(str(rec.get("sellerId") or ""))
    return (np.array(X, dtype=np.float32), np.array(y, dtype=np.float64),
            np.array(timestamps), seller_ids)


def train_price_model_v2(data_path: str, output_dir: str = None,
                         conformal_alpha: float = None, seed: int = 42):
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    import lightgbm as lgb
    from pipeline import config

    output_dir = output_dir or os.path.join(os.path.dirname(__file__), "..", "models_saved")
    os.makedirs(output_dir, exist_ok=True)
    conformal_alpha = conformal_alpha or config.PRICE_CONFORMAL_ALPHA

    records, data_source = _load_dataset(data_path)
    _refuse_synthetic_to_production(output_dir, data_source)
    X, y, timestamps, _ = _build_features(records)
    print(f"Loaded {len(y)} price samples (log-price target) [data source: {data_source}]")

    if len(timestamps) > 0 and np.min(timestamps) > 0:
        order = np.argsort(timestamps)
        cut = int(len(order) * 0.8)
        train_idx, test_idx = order[:cut], order[cut:]
        print("Using time-based split (80/20 by timestamp)")
    else:
        rng = np.random.RandomState(seed)
        idx = rng.permutation(len(y))
        cut = int(len(y) * 0.8)
        train_idx, test_idx = idx[:cut], idx[cut:]
        print("Using random split (80/20)")

    # Inner conformal split from train
    rng = np.random.RandomState(seed)
    perm = rng.permutation(len(train_idx))
    calib_cut = int(len(train_idx) * 0.25)
    calib_idx = train_idx[perm[:calib_cut]]
    fit_idx = train_idx[perm[calib_cut:]]

    params = {
        "objective": "quantile",
        "metric": "quantile",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_child_samples": 20,
        "seed": seed,
        "verbose": -1,
    }

    models = {}
    preds_calib = {}
    for q, tag in ((0.1, "p10"), (0.5, "p50"), (0.9, "p90")):
        p = dict(params)
        p["alpha"] = q
        print(f"Training {tag} quantile regressor on log-price...")
        m = lgb.train(p, lgb.Dataset(X[fit_idx], label=y[fit_idx]), num_boost_round=300)
        m.save_model(os.path.join(output_dir, f"price_v2_{tag}.txt"))
        models[tag] = m
        preds_calib[tag] = m.predict(X[calib_idx])

    # ── Conformal calibration (normalized nonconformity in log space) ──
    q10, q50, q90 = preds_calib["p10"], preds_calib["p50"], preds_calib["p90"]
    y_cal = y[calib_idx]
    scores = np.maximum(q10 - y_cal, y_cal - q90)
    width = float(np.quantile(scores, min(1.0, 1 - conformal_alpha + (1 / max(1, len(scores))) * 1.0)))
    print(f"Conformal width (log-space, alpha={conformal_alpha}): {width:.4f}")

    with open(os.path.join(output_dir, "price_v2_conformal.json"), "w") as f:
        json.dump({"width": width, "alpha": conformal_alpha,
                   "data_source": data_source,
                   "n_calib": int(len(calib_idx)), "n_train": int(len(fit_idx)),
                   "n_test": int(len(test_idx))}, f, indent=2)
    print(f"Saved price v2 artifacts to {output_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train LightGBM Quantile Price Model v2")
    parser.add_argument("--data", type=str, default="training/sold_listings.jsonl")
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--alpha", type=float, default=None)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    train_price_model_v2(args.data, args.output, args.alpha, args.seed)
