"""
Metrics for the ReSell ML eval harness.

Fraud: precision, recall, F1, PR-AUC (average precision), recall@2% FPR.
Price: MAE and MAPE on log-price, p25-p75 interval coverage.
Latency: p50/p95.
"""

import numpy as np
from sklearn.metrics import average_precision_score, precision_score, recall_score, f1_score


def recall_at_fpr(y_true: np.ndarray, scores: np.ndarray, target_fpr: float = 0.02) -> float:
    """Recall achieved when the threshold is set so that FPR <= target_fpr."""
    neg_scores = scores[y_true == 0]
    if len(neg_scores) == 0:
        return 0.0
    threshold = np.quantile(neg_scores, 1 - target_fpr)
    # Strict > : with calibrated/saturated scores (e.g., isotonic collapsing to
    # exactly 0.0/1.0) a >= threshold would count all tied negatives as FPs.
    preds = scores > threshold
    tp = int(np.sum(preds & (y_true == 1)))
    fp = int(np.sum(preds & (y_true == 0)))
    actual_fpr = fp / max(1, len(neg_scores))
    if actual_fpr > target_fpr * 1.5:  # degenerate (e.g., all scores identical)
        return 0.0
    return tp / max(1, int(np.sum(y_true == 1)))


def fraud_metrics(y_true: np.ndarray, scores_0_1: np.ndarray,
                  threshold: float) -> dict:
    """Full fraud metric set at a given operating threshold on 0-1 scores."""
    y_true = np.asarray(y_true, dtype=np.int32)
    scores = np.asarray(scores_0_1, dtype=np.float64)
    preds = (scores >= threshold).astype(np.int32)

    return {
        "threshold": round(float(threshold), 4),
        "precision": round(float(precision_score(y_true, preds, zero_division=0)), 4),
        "recall": round(float(recall_score(y_true, preds, zero_division=0)), 4),
        "f1": round(float(f1_score(y_true, preds, zero_division=0)), 4),
        "pr_auc": round(float(average_precision_score(y_true, scores)) if len(np.unique(y_true)) > 1 else 0.0, 4),
        "recall_at_2pct_fpr": round(recall_at_fpr(y_true, scores, 0.02), 4),
        "flagged_rate": round(float(preds.mean()), 4),
    }


def price_metrics(y_true_prices: np.ndarray, pred_prices: np.ndarray,
                  p25: np.ndarray = None, p75: np.ndarray = None,
                  p10: np.ndarray = None, p90: np.ndarray = None) -> dict:
    """
    Price metric set.
    - MAE on log-price (multiplicative error in log space)
    - MAPE on the original price scale
    - Interval coverage: fraction of true prices inside the interval
    """
    y = np.asarray(y_true_prices, dtype=np.float64)
    p = np.asarray(pred_prices, dtype=np.float64)
    mask = (y > 0) & (p > 0) & np.isfinite(p)
    y, p = y[mask], p[mask]
    if len(y) == 0:
        return {"mae_log": None, "mape": None, "coverage_p25_p75": None}

    log_err = np.abs(np.log(p) - np.log(y))
    out = {
        "mae_log": round(float(np.mean(log_err)), 4),
        "mape": round(float(np.mean(np.abs(p - y) / y)), 4),
        "rmse_log": round(float(np.sqrt(np.mean(log_err ** 2))), 4),
    }

    def coverage(lo, hi):
        if lo is None or hi is None:
            return None
        lo, hi = np.asarray(lo, dtype=np.float64)[mask], np.asarray(hi, dtype=np.float64)[mask]
        return round(float(np.mean((y >= lo) & (y <= hi))), 4)

    out["coverage_p25_p75"] = coverage(p25, p75)
    out["coverage_p10_p90"] = coverage(p10, p90)
    return out


def calibration_curve(y_true: np.ndarray, probs: np.ndarray, n_bins: int = 10) -> list:
    """
    Reliability (calibration) curve: per equal-width probability bin, the mean
    predicted probability vs the observed positive rate. Returns a list of
    {bin_low, bin_high, mean_predicted, frac_pos, count}; empty bins omitted.
    """
    y = np.asarray(y_true, dtype=np.int32)
    p = np.asarray(probs, dtype=np.float64)
    out = []
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (p >= lo) & (p < hi if i < n_bins - 1 else p <= hi)
        if not mask.any():
            continue
        out.append({
            "bin_low": round(float(lo), 2),
            "bin_high": round(float(hi), 2),
            "mean_predicted": round(float(np.mean(p[mask])), 4),
            "frac_pos": round(float(np.mean(y[mask])), 4),
            "count": int(mask.sum()),
        })
    return out


def latency_metrics(latencies_ms: list) -> dict:
    """Latency percentiles p50/p95 (+ mean) in ms."""
    a = np.array(latencies_ms, dtype=np.float64)
    if len(a) == 0:
        return {"p50_ms": None, "p95_ms": None, "mean_ms": None}
    return {
        "p50_ms": round(float(np.percentile(a, 50)), 2),
        "p95_ms": round(float(np.percentile(a, 95)), 2),
        "mean_ms": round(float(np.mean(a)), 2),
    }
