"""
Fraud and Risk Detection Service for ReSell
Combines multiple multi-modal signals:
  (a) pHash exact / near duplicate match
  (b) Embedding nearest-neighbor similarity across other users' listings
  (c) CLIP image-vs-title semantic coherence
  (d) EXIF / metadata anomaly flags (stock photo dimensions, suspicious ratios)
  (e) Rule features: price deviation from category median, account age, listing velocity
Produces a calibrated 0-100 risk score, risk level, detailed signals, and human-readable reasons.
Structured with modular feature extraction so a trained LightGBM classifier can be plugged in.
"""

import math
import logging
from typing import Dict, Any, List, Optional
import numpy as np

logger = logging.getLogger("ml-service.fraud")

# Default thresholds
DEFAULT_EMBEDDING_SIMILARITY_THRESHOLD = 0.88
DEFAULT_PHASH_DISTANCE_THRESHOLD = 8


def hamming_distance(hash1: str, hash2: str) -> int:
    """Compute Hamming distance between two hex/binary perceptual hashes"""
    if not hash1 or not hash2:
        return 64
    try:
        # Convert hex to integer
        v1 = int(hash1, 16)
        v2 = int(hash2, 16)
        return bin(v1 ^ v2).count('1')
    except Exception:
        # If binary string
        return sum(c1 != c2 for c1, c2 in zip(str(hash1), str(hash2)))


def extract_fraud_features(
    listing: Dict[str, Any],
    candidate_listings: List[Dict[str, Any]] = None,
    image_title_similarity: Optional[float] = None,
    category_median_price: Optional[float] = None
) -> Dict[str, float]:
    """
    Extract structured numeric feature vector for fraud risk scoring / LightGBM.
    """
    candidate_listings = candidate_listings or []
    seller_id = str(listing.get("sellerId") or listing.get("seller", ""))
    target_phash = listing.get("perceptualHash", "")
    target_emb = listing.get("embedding")

    # (a) pHash features
    min_phash_dist = 64
    phash_exact_match = 0
    if target_phash:
        for cand in candidate_listings:
            cand_seller = str(cand.get("sellerId") or cand.get("seller", ""))
            if cand_seller and cand_seller == seller_id:
                continue  # Skip same seller relists
            for c_hash in (cand.get("imageHashes") or [cand.get("perceptualHash")]):
                if c_hash:
                    dist = hamming_distance(target_phash, str(c_hash))
                    if dist < min_phash_dist:
                        min_phash_dist = dist
                    if dist <= 4:
                        phash_exact_match = 1

    # (b) Embedding similarity features
    max_emb_sim = 0.0
    if target_emb and len(target_emb) > 0:
        target_v = np.array(target_emb, dtype=np.float32)
        norm_t = np.linalg.norm(target_v)
        if norm_t > 0:
            target_v /= norm_t
            for cand in candidate_listings:
                cand_seller = str(cand.get("sellerId") or cand.get("seller", ""))
                if cand_seller and cand_seller == seller_id:
                    continue
                cand_emb = cand.get("embedding")
                if cand_emb and len(cand_emb) == len(target_v):
                    c_v = np.array(cand_emb, dtype=np.float32)
                    norm_c = np.linalg.norm(c_v)
                    if norm_c > 0:
                        sim = float(np.dot(target_v, c_v / norm_c))
                        if sim > max_emb_sim:
                            max_emb_sim = sim

    # (c) CLIP image-vs-title similarity
    title_sim = image_title_similarity if image_title_similarity is not None else 0.5

    # (d) EXIF / metadata features
    metadata = listing.get("metadata", {}) or {}
    width = metadata.get("width") or listing.get("width") or 800
    height = metadata.get("height") or listing.get("height") or 600
    aspect_ratio = width / max(1, height)
    is_stock_dimensions = 1 if (width in [1920, 1200, 1000] and height in [1080, 800, 1000]) else 0
    has_suspicious_software = 1 if any(s in str(metadata.get("software", "")).lower() for s in ["photoshop", "gimp", "canva"]) else 0

    # (e) Behavioral / Rule features
    price = float(listing.get("price", 0))
    cat_median = float(category_median_price or listing.get("categoryMedianPrice", price or 1))
    price_ratio = (price / cat_median) if cat_median > 0 else 1.0
    price_too_low = 1 if price_ratio < 0.25 else 0
    price_too_high = 1 if price_ratio > 4.0 else 0

    account_age_hours = float(listing.get("accountAgeHours", 720)) # default 30 days
    is_brand_new_account = 1 if account_age_hours < 48 else 0

    listings_past_hour = float(listing.get("listingsPastHour", 1))
    is_high_velocity = 1 if listings_past_hour > 6 else 0

    return {
        "min_phash_dist": float(min_phash_dist),
        "phash_exact_match": float(phash_exact_match),
        "max_emb_sim": float(max_emb_sim),
        "title_similarity": float(title_sim),
        "aspect_ratio": float(aspect_ratio),
        "is_stock_dimensions": float(is_stock_dimensions),
        "has_suspicious_software": float(has_suspicious_software),
        "price_ratio": float(price_ratio),
        "price_too_low": float(price_too_low),
        "price_too_high": float(price_too_high),
        "account_age_hours": float(account_age_hours),
        "is_brand_new_account": float(is_brand_new_account),
        "listings_past_hour": float(listings_past_hour),
        "is_high_velocity": float(is_high_velocity),
    }


class LightGBMFraudModel:
    """Placeholder for loaded LightGBM binary fraud classifier"""
    def __init__(self, model_path: Optional[str] = None):
        self.model = None
        if model_path:
            try:
                import lightgbm as lgb
                self.model = lgb.Booster(model_file=model_path)
                logger.info(f"Loaded LightGBM fraud model from {model_path}")
            except Exception as e:
                logger.warning(f"Could not load LightGBM model from {model_path}: {e}")

    def predict_score(self, features: Dict[str, float]) -> Optional[float]:
        if self.model is None:
            return None
        feat_vals = np.array([list(features.values())], dtype=np.float32)
        prob = float(self.model.predict(feat_vals)[0])
        return prob * 100.0


# Global classifier instance (can be loaded with model file)
_lgb_fraud_model = LightGBMFraudModel()


def evaluate_fraud_risk(
    listing: Dict[str, Any],
    candidate_listings: List[Dict[str, Any]] = None,
    image_title_similarity: Optional[float] = None,
    category_median_price: Optional[float] = None,
    emb_sim_threshold: float = DEFAULT_EMBEDDING_SIMILARITY_THRESHOLD,
    phash_dist_threshold: int = DEFAULT_PHASH_DISTANCE_THRESHOLD
) -> Dict[str, Any]:
    """
    Main evaluation pipeline for fraud check.
    Combines rule-based feature scoring with optional LightGBM prediction.
    """
    features = extract_fraud_features(
        listing,
        candidate_listings,
        image_title_similarity,
        category_median_price
    )

    reasons = []
    signals = {}
    score = 0.0

    # 1. Image Duplicate Check (pHash)
    if features["min_phash_dist"] <= phash_dist_threshold:
        weight = 40 if features["phash_exact_match"] == 1 else 25
        score += weight
        dist = int(features["min_phash_dist"])
        sim_pct = round((1 - dist / 64) * 100)
        reasons.append(f"Image perceptual hash match ({sim_pct}% identical, Hamming distance: {dist})")
        signals["phash_duplicate"] = {"detected": True, "distance": dist, "similarity_pct": sim_pct}
    else:
        signals["phash_duplicate"] = {"detected": False, "distance": int(features["min_phash_dist"])}

    # 2. Embedding Nearest-Neighbor Duplicate Check
    if features["max_emb_sim"] >= emb_sim_threshold:
        score += 35
        sim_pct = round(features["max_emb_sim"] * 100, 1)
        reasons.append(f"High visual feature similarity to another listing ({sim_pct}% vector match)")
        signals["vector_duplicate"] = {"detected": True, "similarity": features["max_emb_sim"]}
    elif features["max_emb_sim"] >= (emb_sim_threshold - 0.08):
        score += 15
        signals["vector_duplicate"] = {"detected": True, "similarity": features["max_emb_sim"]}
    else:
        signals["vector_duplicate"] = {"detected": False, "similarity": features["max_emb_sim"]}

    # 3. CLIP Image vs Title Coherence
    if features["title_similarity"] < 0.18:
        score += 25
        reasons.append(f"Image does not appear to match product title (low semantic relevance: {round(features['title_similarity'], 2)})")
        signals["title_image_mismatch"] = {"detected": True, "similarity": features["title_similarity"]}
    else:
        signals["title_image_mismatch"] = {"detected": False, "similarity": features["title_similarity"]}

    # 4. EXIF & Metadata Anomaly
    if features["is_stock_dimensions"] == 1:
        score += 10
        signals["stock_photo_dimensions"] = True
    if features["has_suspicious_software"] == 1:
        score += 15
        reasons.append("Image metadata shows image editor software manipulation")
        signals["software_editing"] = True

    # 5. Price Outlier Check
    if features["price_too_low"] == 1:
        score += 25
        ratio_pct = round(features["price_ratio"] * 100)
        reasons.append(f"Listing price is suspiciously low ({ratio_pct}% of category median)")
        signals["price_anomaly"] = {"too_low": True, "ratio": features["price_ratio"]}
    elif features["price_too_high"] == 1:
        score += 10
        signals["price_anomaly"] = {"too_high": True, "ratio": features["price_ratio"]}
    else:
        signals["price_anomaly"] = {"normal": True, "ratio": features["price_ratio"]}

    # 6. Account Velocity & Age Check
    if features["is_brand_new_account"] == 1 and features["is_high_velocity"] == 1:
        score += 30
        reasons.append(f"New account created < 48h ago listing at high frequency ({int(features['listings_past_hour'])} listings/hour)")
        signals["high_velocity_new_account"] = True
    elif features["is_brand_new_account"] == 1:
        score += 10
        signals["new_account"] = True
    elif features["is_high_velocity"] == 1:
        score += 15
        reasons.append(f"High listing velocity detected ({int(features['listings_past_hour'])} listings in past hour)")
        signals["high_velocity"] = True

    # Check if LightGBM model is available to refine or blend the score
    lgb_score = _lgb_fraud_model.predict_score(features)
    if lgb_score is not None:
        # Weighted ensemble: 50% rules, 50% LightGBM
        final_score = (score * 0.5) + (lgb_score * 0.5)
        signals["lgb_model_score"] = round(lgb_score, 1)
    else:
        final_score = score

    # Clamp to [0, 100]
    final_score = max(0.0, min(100.0, round(final_score, 1)))

    if final_score >= 70.0:
        risk_level = "high"
        status_recommendation = "pendingReview"
    elif final_score >= 40.0:
        risk_level = "medium"
        status_recommendation = "active"
    else:
        risk_level = "low"
        status_recommendation = "active"

    return {
        "fraudScore": final_score,
        "riskLevel": risk_level,
        "isFlagged": final_score >= 70.0,
        "statusRecommendation": status_recommendation,
        "fraudReasons": reasons,
        "signals": signals,
        "features": features
    }
