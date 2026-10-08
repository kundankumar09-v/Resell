"""
Prediction logging & feedback store.
- Stores every prediction with its inputs, features, and output (JSONL, append-only).
- Later outcomes (admin decisions, final sold prices) are attached by record id.
- Drift report: compares recent feature distributions against the training window.
"""

import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

import numpy as np

from . import config

logger = logging.getLogger("ml-service.pipeline.logging")

_lock = threading.Lock()


def log_prediction(kind: str, record_id: str, inputs: Dict[str, Any],
                   features: Dict[str, float], output: Dict[str, Any]):
    """Append one prediction record: {id, kind, ts, inputs, features, output, outcome:null}."""
    rec = {
        "id": str(record_id),
        "kind": str(kind),  # "fraud" | "price"
        "ts": time.time(),
        "inputs": inputs,
        "features": features,
        "output": output,
        "outcome": None,
    }
    try:
        os.makedirs(os.path.dirname(config.PREDICTION_LOG_PATH), exist_ok=True)
        with _lock:
            with open(config.PREDICTION_LOG_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, default=str) + "\n")
    except Exception as e:
        logger.warning(f"Could not log prediction: {e}")


def record_outcome(record_id: str, outcome: Dict[str, Any],
                   log_path: Optional[str] = None) -> bool:
    """Attach a later outcome (admin decision, sold price) to a prediction record."""
    path = log_path or config.PREDICTION_LOG_PATH
    if not os.path.exists(path):
        return False
    updated = False
    lines = []
    try:
        with _lock:
            with open(path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            for i, line in enumerate(lines):
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("id") == str(record_id) and rec.get("outcome") is None:
                    rec["outcome"] = outcome
                    lines[i] = json.dumps(rec, default=str) + "\n"
                    updated = True
            if updated:
                with open(path, "w", encoding="utf-8") as f:
                    f.writelines(lines)
        return updated
    except Exception as e:
        logger.warning(f"Could not record outcome: {e}")
        return False


def load_records(kind: Optional[str] = None, path: Optional[str] = None) -> List[Dict[str, Any]]:
    path = path or config.PREDICTION_LOG_PATH
    if not os.path.exists(path):
        return []
    recs = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if kind is None or rec.get("kind") == kind:
                recs.append(rec)
    return recs


# ── Drift report ───────────────────────────────────────────────────

def _feature_values(records: List[Dict[str, Any]], feature: str) -> np.ndarray:
    vals = []
    for r in records:
        v = (r.get("features") or {}).get(feature)
        if v is not None:
            try:
                vals.append(float(v))
            except (TypeError, ValueError):
                pass
    return np.array(vals, dtype=np.float64)


def drift_report(recent_hours: float = 24.0, feature_whitelist: Optional[List[str]] = None) -> Dict[str, Any]:
    """
    Compare recent feature distributions against older records (training proxy).
    Metric: normalized mean-shift per feature (|mu_recent - mu_ref| / (std_ref + eps)).
    Flag threshold: shift > 0.25.
    """
    records = load_records()
    if len(records) < 50:
        return {"status": "insufficient_data", "records": len(records), "features": []}

    now = time.time()
    recent = [r for r in records if now - r.get("ts", 0) <= recent_hours * 3600]
    reference = [r for r in records if now - r.get("ts", 0) > recent_hours * 3600]
    if not recent or not reference:
        return {"status": "insufficient_data", "records": len(records),
                "recent": len(recent), "reference": len(reference), "features": []}

    features = feature_whitelist or sorted({k for r in records[:20] for k in (r.get("features") or {})})
    report_features = []
    for feat in features:
        v_new, v_ref = _feature_values(recent, feat), _feature_values(reference, feat)
        if len(v_new) < 5 or len(v_ref) < 5:
            continue
        shift = abs(float(np.mean(v_new) - np.mean(v_ref))) / (float(np.std(v_ref)) + 1e-6)
        report_features.append({
            "feature": feat,
            "mean_recent": round(float(np.mean(v_new)), 4),
            "mean_reference": round(float(np.mean(v_ref)), 4),
            "normalized_shift": round(shift, 4),
            "drifted": bool(shift > 0.25),
        })

    drifted = [f["feature"] for f in report_features if f["drifted"]]
    return {
        "status": "ok",
        "generated_at": now,
        "recent_hours": recent_hours,
        "records_total": len(records),
        "records_recent": len(recent),
        "records_reference": len(reference),
        "features": report_features,
        "drifted_features": drifted,
        "retrain_recommended": len(drifted) > 0,
    }
