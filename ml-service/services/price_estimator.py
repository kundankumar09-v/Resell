"""
Price Estimation Service for ReSell
Estimates fair market price and uncertainty intervals (median, p25, p75, min, max)
using k-Nearest Neighbors (kNN) over 512-D CLIP embeddings within category.
Structured so a LightGBM quantile regression model can be loaded and predict directly.
"""

import math
import logging
import numpy as np
from typing import Dict, Any, List, Optional
from .vector_index import VectorIndex

logger = logging.getLogger("ml-service.price")

# Condition degradation multipliers
CONDITION_MULTIPLIERS = {
    "new": 1.0,
    "like-new": 0.88,
    "good": 0.75,
    "fair": 0.58,
    "poor": 0.40,
}


def extract_price_features(
    target_item: Dict[str, Any],
    comparable_items: List[Dict[str, Any]] = None
) -> Dict[str, float]:
    """
    Extract structured tabular features for LightGBM quantile model training & inference.
    """
    original_price = float(target_item.get("originalPrice") or 0)
    years_used = float(target_item.get("yearsUsed") or 0)
    condition = str(target_item.get("condition") or "good").lower()
    condition_weight = CONDITION_MULTIPLIERS.get(condition, 0.75)

    comp_prices = [float(c.get("price", 0)) for c in (comparable_items or []) if float(c.get("price", 0)) > 0]
    comp_mean = float(np.mean(comp_prices)) if comp_prices else original_price * condition_weight
    comp_std = float(np.std(comp_prices)) if len(comp_prices) > 1 else 0.0

    return {
        "original_price": original_price,
        "years_used": years_used,
        "condition_weight": condition_weight,
        "comparable_count": float(len(comp_prices)),
        "comparable_mean": comp_mean,
        "comparable_std": comp_std,
    }


class LightGBMQuantilePriceModel:
    """
    Quantile regression price predictor using LightGBM (p25, p50/median, p75).
    """
    def __init__(self, model_prefix: Optional[str] = None):
        self.model_p25 = None
        self.model_p50 = None
        self.model_p75 = None
        if model_prefix:
            try:
                import lightgbm as lgb
                self.model_p25 = lgb.Booster(model_file=f"{model_prefix}_p25.txt")
                self.model_p50 = lgb.Booster(model_file=f"{model_prefix}_p50.txt")
                self.model_p75 = lgb.Booster(model_file=f"{model_prefix}_p75.txt")
                logger.info(f"Loaded LightGBM Quantile models with prefix: {model_prefix}")
            except Exception as e:
                logger.warning(f"Could not load LightGBM Quantile models from {model_prefix}: {e}")

    def is_available(self) -> bool:
        return self.model_p50 is not None

    def predict_quantiles(self, features: Dict[str, float], embedding: Optional[List[float]] = None) -> Optional[Dict[str, float]]:
        if not self.is_available():
            return None
        feat_list = list(features.values())
        if embedding:
            feat_list.extend(embedding[:64]) # Project top components if trained with embeddings
        feat_arr = np.array([feat_list], dtype=np.float32)

        p25 = float(self.model_p25.predict(feat_arr)[0])
        median = float(self.model_p50.predict(feat_arr)[0])
        p75 = float(self.model_p75.predict(feat_arr)[0])

        return {
            "p25": round(max(0, p25), 2),
            "median": round(max(0, median), 2),
            "p75": round(max(p25, p75), 2),
        }


# Global quantile model instance
_lgb_quantile_model = LightGBMQuantilePriceModel()


def estimate_price_knn(
    target_embedding: Optional[List[float]],
    target_metadata: Dict[str, Any],
    comparables: List[Dict[str, Any]],
    k_neighbors: int = 5
) -> Dict[str, Any]:
    """
    Estimate product price using kNN over visual embeddings + category comparables.
    Returns:
      - suggestedPrice (median estimate)
      - priceRange: { min, max, p25, p75 }
      - confidence (0.0 - 1.0)
      - explanation
      - factors
    """
    condition = str(target_metadata.get("condition") or "good").lower()
    cond_factor = CONDITION_MULTIPLIERS.get(condition, 0.75)
    orig_price = float(target_metadata.get("originalPrice") or 0)
    years_used = float(target_metadata.get("yearsUsed") or 0)
    target_cat = str(target_metadata.get("category") or "")

    # Filter comparables with valid prices > 0
    valid_comps = [c for c in comparables if float(c.get("price") or 0) > 0]
    
    # If category matches exist, prefer same-category comparables
    if target_cat:
        cat_comps = [c for c in valid_comps if str(c.get("category") or "") == target_cat]
        if len(cat_comps) >= 3:
            valid_comps = cat_comps

    weighted_prices = []
    similarities = []

    if target_embedding and len(target_embedding) == 512 and len(valid_comps) > 0:
        index = VectorIndex(dimension=512)
        index.build_index(valid_comps)
        results = index.search_knn(
            np.array(target_embedding, dtype=np.float32),
            k=k_neighbors
        )
        for item, sim in results:
            price = float(item.get("price", 0))
            if price > 0:
                # Similarity weighting (clip to [0.2, 1.0])
                weight = max(0.2, float(sim))
                weighted_prices.append((price, weight))
                similarities.append(float(sim))

    # Fallback to standard comparables if embeddings are missing / insufficient
    if not weighted_prices and valid_comps:
        for item in valid_comps[:k_neighbors]:
            price = float(item.get("price", 0))
            if price > 0:
                weighted_prices.append((price, 1.0))
                similarities.append(0.6)

    # Check if LightGBM Quantile model is available
    features = extract_price_features(target_metadata, valid_comps)
    lgb_quantiles = _lgb_quantile_model.predict_quantiles(features, target_embedding)

    if lgb_quantiles is not None:
        median_price = lgb_quantiles["median"]
        p25_price = lgb_quantiles["p25"]
        p75_price = lgb_quantiles["p75"]
        min_price = round(p25_price * 0.85, 2)
        max_price = round(p75_price * 1.15, 2)
        confidence = 0.88
        source = "ml-lightgbm-quantile"
        explanation = f"ML model estimated fair market price based on visual embedding, condition ({condition}), and market transactions."
    elif weighted_prices:
        prices = [p for p, _ in weighted_prices]
        weights = np.array([w for _, w in weighted_prices])
        weights /= np.sum(weights)

        # Compute weighted percentiles
        sorted_indices = np.argsort(prices)
        sorted_prices = np.array(prices)[sorted_indices]
        sorted_weights = weights[sorted_indices]
        cum_weights = np.cumsum(sorted_weights)

        def get_weighted_percentile(p):
            idx = np.searchsorted(cum_weights, p)
            idx = min(idx, len(sorted_prices) - 1)
            return float(sorted_prices[idx])

        median_price = round(get_weighted_percentile(0.50), 2)
        p25_price = round(get_weighted_percentile(0.25), 2)
        p75_price = round(get_weighted_percentile(0.75), 2)
        min_price = round(float(np.min(prices)) * 0.9, 2)
        max_price = round(float(np.max(prices)) * 1.1, 2)

        # Confidence based on neighbor similarity and count
        avg_sim = float(np.mean(similarities)) if similarities else 0.5
        count_factor = min(1.0, len(weighted_prices) / max(1, k_neighbors))
        confidence = round(0.5 * avg_sim + 0.4 * count_factor + 0.1, 2)
        source = "ml-embedding-knn"
        explanation = f"AI estimated market price based on {len(weighted_prices)} visually similar listings in this category."
    else:
        # Heuristic baseline from original price & depreciation
        if orig_price > 0:
            deprec_rate = max(0.25, 1.0 - (years_used * 0.15))
            base_est = orig_price * cond_factor * deprec_rate
        else:
            base_est = 50.0

        median_price = round(base_est, 2)
        p25_price = round(base_est * 0.82, 2)
        p75_price = round(base_est * 1.18, 2)
        min_price = round(base_est * 0.70, 2)
        max_price = round(base_est * 1.30, 2)
        confidence = 0.45
        source = "heuristic-baseline"
        explanation = f"Estimated from standard depreciation and condition ({condition}). Add images to refine price."

    factors = [
        f"Condition assessment: {condition.title()} ({int(cond_factor * 100)}% base value)",
    ]
    if years_used > 0:
        factors.append(f"Age depreciation: {years_used} years used")
    if len(weighted_prices) > 0:
        factors.append(f"Matched {len(weighted_prices)} comparable listings via CLIP embedding kNN")

    return {
        "suggestedPrice": median_price,
        "priceRange": {
            "min": min_price,
            "max": max_price,
            "p25": p25_price,
            "p75": p75_price,
        },
        "confidence": confidence,
        "source": source,
        "explanation": explanation,
        "factors": factors,
        "comparableCount": len(weighted_prices)
    }
