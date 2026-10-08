"""
Price pipeline v2: LightGBM quantile regression (0.1/0.5/0.9) on log-price with
kNN-median and neighbor-spread features, plus conformal interval calibration.

Key changes vs the legacy heuristic path (services/price_estimator.py):
- Quantiles 0.1/0.5/0.9 on LOG-price (multiplicative errors become additive).
- kNN-median + neighbor-spread features from HNSW ANN (category pre-filter).
- Conformal calibration of intervals (guaranteed ~80% coverage).
- Outlier cleaning (MAD-based) and sold-price preference.
- Low confidence -> wide range or no suggestion.
"""

import json
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from . import config
from .ann_index import ann_index

logger = logging.getLogger("ml-service.pipeline.price_v2")

CONDITION_MULTIPLIERS = {"new": 1.0, "like-new": 0.88, "good": 0.75, "fair": 0.58, "poor": 0.40}

TABULAR_FEATURES = [
    "log_original_price",
    "years_used",
    "condition_weight",
    "is_sold_present",
    "knn_median_log_price",
    "knn_spread_log_price",
    "knn_count",
    "category_median_log_price",
]


def clean_outliers(prices: np.ndarray) -> np.ndarray:
    """MAD-based outlier cleaning of comparable prices (keeps positive values)."""
    if len(prices) == 0:
        return prices
    med = np.median(prices)
    mad = np.median(np.abs(prices - med))
    if mad <= 0:
        return prices[(prices > 0)]
    lo = med - config.PRICE_OUTLIER_MAD * 1.4826 * mad
    hi = med + config.PRICE_OUTLIER_MAD * 1.4826 * mad
    return prices[(prices >= lo) & (prices <= hi) & (prices > 0)]


def _comp_price(c: Dict[str, Any]) -> float:
    """Prefer sold prices over asking prices."""
    sold = c.get("soldPrice") or c.get("lastSoldPrice")
    if sold and float(sold) > 0:
        return float(sold)
    return float(c.get("price", 0) or 0)


def _is_sold(c: Dict[str, Any]) -> bool:
    if c.get("soldPrice") or c.get("lastSoldPrice"):
        return True
    return str(c.get("status", "")).lower() in ("sold", "completed", "closed")


def extract_price_features_v2(
    target_metadata: Dict[str, Any],
    comparables: List[Dict[str, Any]],
    k_neighbors: Optional[int] = None,
    use_ann: bool = True,
) -> Tuple[Dict[str, float], List[Tuple[Dict[str, Any], float]], Dict[str, float]]:
    """
    Extract v2 price features. Returns (features, knn_neighbors_list, timings).
    kNN neighbors come from the persistent HNSW ANN with category pre-filter,
    falling back to recency-ordered comparables.
    """
    t0 = time.perf_counter()
    timings: Dict[str, float] = {}
    k = k_neighbors or config.KNN_NEIGHBORS

    cond = str(target_metadata.get("condition") or "good").lower()
    cond_w = CONDITION_MULTIPLIERS.get(cond, 0.75)
    orig = float(target_metadata.get("originalPrice") or 0)
    years = float(target_metadata.get("yearsUsed") or 0)
    target_cat = str(target_metadata.get("category") or "")

    # ── Clean + prefer sold comparables ───────────────────────────
    ts = time.perf_counter()
    valid = [c for c in comparables if _comp_price(c) > 0]
    sold = [c for c in valid if _is_sold(c)]
    if len(sold) >= 3:
        # Sold comps get weight and are searched first; active kept for spread
        pool = sold + [c for c in valid if c not in sold][:max(3, len(sold))]
    else:
        pool = valid
    timings["clean_ms"] = (time.perf_counter() - ts) * 1000

    # ── kNN via HNSW ANN (category pre-filter) or fallback ────────
    ts = time.perf_counter()
    neighbors: List[Tuple[Dict[str, Any], float]] = []
    target_emb = target_metadata.get("embedding")
    if use_ann and target_emb and len(target_emb) == 512 and len(pool) > 0:
        neighbors = ann_index.search(
            np.array(target_emb, dtype=np.float32), k=k, category=target_cat or None,
            exclude_ids={str(target_metadata.get("id") or target_metadata.get("_id", ""))} or None,
        )
    if not neighbors:
        # Recency fallback: first k comps (already sold-preferring)
        for c in pool[:k]:
            neighbors.append((c, 0.6))
    timings["knn_ms"] = (time.perf_counter() - ts) * 1000

    # ── kNN-median + neighbor-spread features ─────────────────────
    prices = np.array([_comp_price(item) for item, _ in neighbors], dtype=np.float64)
    prices = prices[prices > 0]
    if len(prices) > 0:
        clean = clean_outliers(prices)
        if len(clean) >= 3:
            prices = clean
        log_prices = np.log(prices)
        knn_med = float(np.median(log_prices))
        knn_spread = float(np.percentile(log_prices, 75) - np.percentile(log_prices, 25)) if len(prices) > 2 else 0.35
    else:
        knn_med, knn_spread = 0.0, 0.35

    pool_prices = np.array([_comp_price(c) for c in pool], dtype=np.float64)
    pool_prices = pool_prices[pool_prices > 0]
    cat_med = float(np.median(pool_prices)) if len(pool_prices) > 0 else 0.0

    features = {
        "log_original_price": float(np.log1p(max(0, orig))),
        "years_used": float(years),
        "condition_weight": float(cond_w),
        "is_sold_present": 1.0 if len(sold) >= 3 else 0.0,
        "knn_median_log_price": float(knn_med),
        "knn_spread_log_price": float(knn_spread),
        "knn_count": float(len(prices)),
        "category_median_log_price": float(np.log1p(cat_med)),
    }
    timings["total_features_ms"] = (time.perf_counter() - t0) * 1000
    return features, neighbors, timings


class QuantilePriceModelV2:
    """LightGBM quantile regressors (0.1/0.5/0.9) on log-price + conformal widths."""

    def __init__(self, model_prefix: Optional[str] = None, conformal_path: Optional[str] = None):
        self.models: Dict[str, Any] = {}
        self.conformal_width: Optional[float] = None
        if model_prefix and os.path.exists(f"{model_prefix}_p10.txt"):
            try:
                import lightgbm as lgb
                for q in ("p10", "p50", "p90"):
                    path = f"{model_prefix}_{q}.txt"
                    if os.path.exists(path):
                        self.models[q] = lgb.Booster(model_file=path)
                logger.info(f"Loaded price v2 quantile models from {model_prefix}")
            except Exception as e:
                logger.warning(f"Could not load price v2 models: {e}")
        if conformal_path and os.path.exists(conformal_path):
            try:
                with open(conformal_path, "r") as f:
                    self.conformal_width = float(json.load(f)["width"])
                logger.info(f"Loaded conformal width {self.conformal_width:.4f}")
            except Exception as e:
                logger.warning(f"Could not load conformal calibration: {e}")

    def is_available(self) -> bool:
        return len(self.models) == 3

    def predict_log_quantiles(self, features: Dict[str, float]) -> Optional[Tuple[float, float, float]]:
        if not self.is_available():
            return None
        X = np.array([[features[k] for k in TABULAR_FEATURES]], dtype=np.float32)
        try:
            q10 = float(self.models["p10"].predict(X)[0])
            q50 = float(self.models["p50"].predict(X)[0])
            q90 = float(self.models["p90"].predict(X)[0])
            return q10, q50, q90
        except Exception as e:
            logger.warning(f"Quantile prediction failed: {e}")
            return None


model_v2 = QuantilePriceModelV2(config.PRICE_MODEL_PREFIX, config.PRICE_CONFORMAL_PATH)


def evaluate_price_v2(
    target_metadata: Dict[str, Any],
    comparables: List[Dict[str, Any]],
    target_embedding: Optional[List[float]] = None,
    k_neighbors: Optional[int] = None,
) -> Dict[str, Any]:
    """
    v2 price pipeline. Returns the legacy response shape (suggestedPrice,
    priceRange, confidence, source, explanation, factors) plus v2 extras.
    Returns a wide range or no suggestion when confidence is low.
    """
    t0 = time.perf_counter()

    meta = dict(target_metadata or {})
    if target_embedding and not meta.get("embedding"):
        meta["embedding"] = target_embedding

    features, neighbors, timings = extract_price_features_v2(
        meta, comparables or [], k_neighbors=k_neighbors
    )

    lq = model_v2.predict_log_quantiles(features)
    timings["model_ms"] = (time.perf_counter() - t0) * 1000

    cond = str(meta.get("condition") or "good").lower()
    cond_w = CONDITION_MULTIPLIERS.get(cond, 0.75)
    orig = float(meta.get("originalPrice") or 0)
    years = float(meta.get("yearsUsed") or 0)

    factors = [f"Condition assessment: {cond.title()} ({int(cond_w * 100)}% base value)"]
    if years > 0:
        factors.append(f"Age depreciation: {years} years used")
    sold_count = sum(1 for item, _ in neighbors if _is_sold(item))
    if sold_count > 0:
        factors.append(f"{sold_count} sold-price comparables used")

    if lq is not None:
        q10, q50, q90 = lq
        # Conformal calibration: widen the interval to guarantee coverage
        if model_v2.conformal_width is not None:
            q10_c, q90_c = q10 - model_v2.conformal_width, q90 + model_v2.conformal_width
        else:
            q10_c, q90_c = q10, q90
        q10_c, q90_c = min(q10_c, q50), max(q90_c, q50)

        median_price = float(np.exp(max(0.0, q50)))
        p25_price = float(np.exp(max(0.0, (q10_c + q50) / 2 if model_v2.conformal_width else q10_c)))
        p75_price = float(np.exp(max(0.0, (q90_c + q50) / 2 if model_v2.conformal_width else q90_c)))
        min_price = float(np.exp(max(0.0, q10_c)))
        max_price = float(np.exp(max(0.0, q90_c)))

        # Confidence from comp count + spread (normalized)
        knn_count = features["knn_count"]
        spread = features["knn_spread_log_price"]
        count_factor = min(1.0, knn_count / max(1, config.KNN_NEIGHBORS))
        spread_factor = max(0.0, 1.0 - spread / 1.5)
        confidence = round(0.6 * count_factor + 0.4 * spread_factor, 2)

        # Low confidence: wide range or no suggestion
        if confidence < 0.35 or knn_count < 3:
            return {
                "suggestedPrice": None,
                "priceRange": {"min": round(min_price, 2), "max": round(max_price, 2),
                               "p25": round(p25_price, 2), "p75": round(p75_price, 2)},
                "confidence": confidence,
                "source": "ml-quantile-v2-wide",
                "explanation": "Low confidence: market data is too sparse or dispersed. "
                               "Showing a wide range only - refine with more images or details.",
                "factors": factors,
                "comparableCount": int(knn_count),
                "intervalCoverageTarget": round(1 - config.PRICE_CONFORMAL_ALPHA, 2),
                "stageTimingsMs": {k: round(v, 2) for k, v in timings.items()},
                "pipelineVersion": "v2",
            }

        return {
            "suggestedPrice": round(median_price, 2),
            "priceRange": {"min": round(min_price, 2), "max": round(max_price, 2),
                           "p25": round(p25_price, 2), "p75": round(p75_price, 2)},
            "confidence": confidence,
            "source": "ml-quantile-v2",
            "explanation": f"Quantile model on {int(knn_count)} comparable listings "
                           f"({sold_count} sold prices), condition ({cond}), conformal 80% interval.",
            "factors": factors,
            "comparableCount": int(knn_count),
            "intervalCoverageTarget": round(1 - config.PRICE_CONFORMAL_ALPHA, 2),
            "stageTimingsMs": {k: round(v, 2) for k, v in timings.items()},
            "pipelineVersion": "v2",
        }

    # Heuristic fallback (same as legacy) when model unavailable
    if orig > 0:
        deprec = max(0.25, 1.0 - years * 0.15)
        base = orig * cond_w * deprec
    else:
        pool_prices = np.array([_comp_price(c) for c in (comparables or [])], dtype=np.float64)
        pool_prices = pool_prices[pool_prices > 0]
        base = float(np.median(clean_outliers(pool_prices))) if len(pool_prices) > 0 else 50.0

    return {
        "suggestedPrice": round(base, 2),
        "priceRange": {"min": round(base * 0.70, 2), "max": round(base * 1.30, 2),
                       "p25": round(base * 0.82, 2), "p75": round(base * 1.18, 2)},
        "confidence": 0.45,
        "source": "heuristic-baseline-v2-fallback",
        "explanation": f"Estimated from depreciation and condition ({cond}).",
        "factors": factors,
        "comparableCount": len(neighbors),
        "stageTimingsMs": {k: round(v, 2) for k, v in timings.items()},
        "pipelineVersion": "v2",
    }
