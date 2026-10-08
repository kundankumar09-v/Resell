"""
Training Script v2: Calibrated LightGBM Fraud Classifier for ReSell.

Improvements over training/train_fraud_model.py:
- Trains on v2 engineered features (cross-seller vs same-seller separated,
  price z-score per category, CLIP image-text similarity, vision-LLM flags).
- Fits an isotonic calibrator (sigmoid fallback) on a holdout split.
- Chooses flag/review thresholds from the PR curve (max-F1 point + operating band).
- Saves: fraud_v2.txt, fraud_v2_calibrator.pkl, fraud_v2_thresholds.json.
"""

import os
import sys
import json
import argparse
import pickle

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
            "Train on real labeled data (MongoDB admin approve/reject + sold prices, "
            "prediction-log feedback via training/retrain.py, or CSV via "
            "eval/data_loader.py), or pass --output pointing at a non-production "
            "directory for debugging.")


def _load_dataset(data_path: str):
    """Supports JSON/JSONL with raw listings+label, or legacy {"features", "label"}."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

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
        print(f"Dataset not found at {data_path}; generating synthetic fraud data...")
        from eval.generate_data import generate_fraud_dataset
        records = generate_fraud_dataset(n=2000, seed=42)
        data_source = "synthetic"

    from pipeline.fraud_v2 import FEATURE_ORDER

    X, y, seller_ids, timestamps = [], [], [], []
    for rec in records:
        if rec.get("synthetic"):
            data_source = "synthetic"
        label = rec.get("label", rec.get("isFraud", rec.get("fraudLabel")))
        if label is None:
            continue
        feats = rec.get("features")
        if feats is None:
            # Raw listing: extract v2 features
            feats, _ = __import__("pipeline.fraud_v2", fromlist=["extract_fraud_features_v2"]) \
                .extract_fraud_features_v2(
                    rec.get("listing", rec),
                    rec.get("candidateListings", rec.get("candidates", [])),
                    rec.get("categoryMedianPrice"),
                )
        elif any(k not in feats for k in FEATURE_ORDER):
            feats = {k: float(feats.get(k, 0.0)) for k in FEATURE_ORDER}
        else:
            feats = {k: float(feats[k]) for k in FEATURE_ORDER}
        X.append([feats[k] for k in FEATURE_ORDER])
        y.append(int(label))
        seller_ids.append(str(rec.get("sellerId") or (rec.get("listing") or {}).get("sellerId") or ""))
        timestamps.append(float(rec.get("timestamp") or rec.get("createdAt") or 0))
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int32), seller_ids, timestamps, data_source


def train_fraud_model_v2(data_path: str, output_dir: str = None, seed: int = 42):
    from sklearn.isotonic import IsotonicRegression
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import precision_recall_curve
    from sklearn.model_selection import train_test_split

    import lightgbm as lgb

    output_dir = output_dir or os.path.join(os.path.dirname(__file__), "..", "models_saved")
    os.makedirs(output_dir, exist_ok=True)

    X, y, seller_ids, timestamps, data_source = _load_dataset(data_path)
    _refuse_synthetic_to_production(output_dir, data_source)
    print(f"Loaded {len(y)} fraud samples ({int(y.sum())} positive, {y.mean()*100:.1f}%) "
          f"[data source: {data_source}]")

    # Time-based split preferred when timestamps exist, else stratified random
    if timestamps and min(timestamps) > 0:
        order = np.argsort(timestamps)
        cut = int(len(order) * 0.8)
        train_idx, test_idx = order[:cut], order[cut:]
        print("Using time-based split (80/20 by timestamp)")
    else:
        train_idx, test_idx = train_test_split(
            np.arange(len(y)), test_size=0.2, random_state=seed, stratify=y)
        print("Using stratified random split (80/20)")

    # Inner calibration split from train
    train_idx, calib_idx = train_test_split(
        train_idx, test_size=0.25, random_state=seed,
        stratify=y[train_idx] if len(np.unique(y[train_idx])) > 1 else None)

    pos_weight = max(1.0, (y[train_idx] == 0).sum() / max(1, (y[train_idx] == 1).sum()))
    params = {
        "objective": "binary",
        "metric": "binary_logloss",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_child_samples": 20,
        "scale_pos_weight": pos_weight,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "seed": seed,
        "verbose": -1,
    }
    print("Training LightGBM fraud classifier v2...")
    model = lgb.train(params, lgb.Dataset(X[train_idx], label=y[train_idx]),
                      num_boost_round=300)

    # ── Calibration on holdout ────────────────────────────────────
    raw_calib = model.predict(X[calib_idx])
    calibrator = None
    try:
        calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        calibrator.fit(raw_calib, y[calib_idx])
        print("Fitted isotonic calibrator")
    except Exception as e:
        print(f"Isotonic failed ({e}); falling back to Platt sigmoid")
        calibrator = LogisticRegression()
        calibrator.fit(raw_calib.reshape(-1, 1), y[calib_idx])

    def calibrated(scores):
        if isinstance(calibrator, IsotonicRegression):
            return np.clip(calibrator.predict(scores), 0.0, 1.0)
        return np.clip(calibrator.predict_proba(scores.reshape(-1, 1))[:, 1], 0.0, 1.0)

    # ── Thresholds from the PR curve (max-F1 on calibration set) ──
    probs_calib = calibrated(raw_calib)
    precision, recall, thresholds = precision_recall_curve(y[calib_idx], probs_calib)
    f1 = 2 * precision[:-1] * recall[:-1] / np.maximum(precision[:-1] + recall[:-1], 1e-9)
    best_idx = int(np.argmax(f1))
    flag_threshold = float(np.clip(thresholds[best_idx], 0.05, 0.95))
    review_threshold = float(np.clip(flag_threshold * 0.5, 0.05, flag_threshold - 0.05))
    print(f"PR-curve thresholds: flag={flag_threshold:.3f} review={review_threshold:.3f} "
          f"(F1={f1[best_idx]:.3f}, P={precision[best_idx]:.3f}, R={recall[best_idx]:.3f})")

    # Save artifacts
    model.save_model(os.path.join(output_dir, "fraud_v2.txt"))
    with open(os.path.join(output_dir, "fraud_v2_calibrator.pkl"), "wb") as f:
        pickle.dump(calibrator, f)
    with open(os.path.join(output_dir, "fraud_v2_thresholds.json"), "w") as f:
        json.dump({"flag_threshold": flag_threshold,
                   "review_threshold": review_threshold,
                   "pr_f1_at_flag": round(float(f1[best_idx]), 4),
                   "data_source": data_source,
                   "trained_at": float(np.max(timestamps)) if timestamps and max(timestamps) > 0 else None,
                   "n_train": int(len(train_idx)), "n_calib": int(len(calib_idx)),
                   "n_test": int(len(test_idx))}, f, indent=2)
    print(f"Saved fraud v2 artifacts to {output_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train Calibrated LightGBM Fraud Model v2")
    parser.add_argument("--data", type=str, default="training/fraud_listings.jsonl")
    parser.add_argument("--output", type=str, default=None)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    train_fraud_model_v2(args.data, args.output, args.seed)
