"""
Retraining orchestrator for ReSell ML pipeline v2.

Retrains both models from the prediction log / labeled datasets, writes a
drift report, and records what was retrained. Intended to be run on a schedule
(e.g., weekly cron) or triggered by the drift report's retrain_recommended flag.

Usage:
    python training/retrain.py                  # retrain both, drift report
    python training/retrain.py --fraud-only
    python training/retrain.py --price-only
    python training/retrain.py --data-dir training
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pipeline import config  # noqa: E402
from pipeline.logging_store import drift_report, load_records  # noqa: E402


def extract_labeled_from_log(out_dir: str) -> dict:
    """
    Convert prediction-log records with outcomes into labeled training data:
    - fraud: outcome.adminDecision ("fraud_confirmed" -> 1, "cleared"/"approved" -> 0)
    - price: outcome.soldPrice / finalPrice as the regression target.
    """
    fraud_recs, price_recs = [], []
    for rec in load_records():
        outcome = rec.get("outcome") or {}
        if rec.get("kind") == "fraud" and outcome:
            decision = str(outcome.get("adminDecision", "")).lower()
            if decision in ("fraud_confirmed", "removed", "rejected"):
                label = 1
            elif decision in ("cleared", "approved", "legit"):
                label = 0
            else:
                continue
            fraud_recs.append({"features": rec.get("features"), "label": label,
                               "timestamp": rec.get("ts"),
                               "sellerId": (rec.get("inputs") or {}).get("sellerId", "")})
        elif rec.get("kind") == "price" and outcome:
            final = outcome.get("soldPrice") or outcome.get("finalPrice")
            if final and float(final) > 0:
                price_recs.append({**(rec.get("inputs") or {}), "price": float(final),
                                   "timestamp": rec.get("ts")})

    paths = {}
    if fraud_recs:
        p = os.path.join(out_dir, "feedback_fraud.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            for r in fraud_recs:
                f.write(json.dumps(r, default=str) + "\n")
        paths["fraud"] = (p, len(fraud_recs))
    if price_recs:
        p = os.path.join(out_dir, "feedback_price.jsonl")
        with open(p, "w", encoding="utf-8") as f:
            for r in price_recs:
                f.write(json.dumps(r, default=str) + "\n")
        paths["price"] = (p, len(price_recs))
    return paths


def main():
    parser = argparse.ArgumentParser(description="Retrain ReSell ML models v2")
    parser.add_argument("--fraud-only", action="store_true")
    parser.add_argument("--price-only", action="store_true")
    parser.add_argument("--data-dir", type=str, default="training")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    started = time.time()
    summary = {"started_at": started, "retrained": []}

    # ── Drift report first ────────────────────────────────────────
    print("=== Drift report ===")
    report = drift_report(recent_hours=24 * 7)
    print(json.dumps({k: v for k, v in report.items() if k != "features"}, indent=2))
    for f in report.get("features", []):
        if f.get("drifted"):
            print(f"  DRIFTED: {f['feature']} shift={f['normalized_shift']}")
    drift_path = os.path.join(config.MODEL_DIR, f"drift_report_{time.strftime('%Y%m%d_%H%M%S')}.json")
    with open(drift_path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"Saved drift report to {drift_path}")

    # ── Feedback data from prediction log ─────────────────────────
    feedback = extract_labeled_from_log(config.MODEL_DIR)
    for kind, (path, n) in feedback.items():
        print(f"Feedback data for {kind}: {n} labeled records at {path}")

    # ── Retrain ───────────────────────────────────────────────────
    from training.train_fraud_v2 import train_fraud_model_v2
    from training.train_price_v2 import train_price_model_v2

    MIN_FEEDBACK_SAMPLES = 50  # fall back to the full dataset below this

    if not args.price_only:
        fb_path, fb_n = feedback.get("fraud", (None, 0))
        if fb_path and fb_n >= MIN_FEEDBACK_SAMPLES:
            fraud_data = fb_path
            print(f"\n=== Retraining fraud model v2 (feedback: {fb_n} samples) ===")
        else:
            fraud_data = os.path.join(args.data_dir, "fraud_listings.jsonl")
            print(f"\n=== Retraining fraud model v2 (insufficient feedback: {fb_n}; "
                  f"using {fraud_data}) ===")
        train_fraud_model_v2(fraud_data, seed=args.seed)
        summary["retrained"].append("fraud")

    if not args.fraud_only:
        fb_path, fb_n = feedback.get("price", (None, 0))
        if fb_path and fb_n >= MIN_FEEDBACK_SAMPLES:
            price_data = fb_path
            print(f"\n=== Retraining price model v2 (feedback: {fb_n} samples) ===")
        else:
            price_data = os.path.join(args.data_dir, "sold_listings.jsonl")
            print(f"\n=== Retraining price model v2 (insufficient feedback: {fb_n}; "
                  f"using {price_data}) ===")
        train_price_model_v2(price_data, seed=args.seed)
        summary["retrained"].append("price")

    summary["finished_at"] = time.time()
    summary["duration_s"] = round(summary["finished_at"] - started, 1)
    summary["drift_report"] = drift_path
    with open(os.path.join(config.MODEL_DIR, "last_retrain.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"\nRetraining complete: {summary['retrained']} in {summary['duration_s']}s")


if __name__ == "__main__":
    main()
