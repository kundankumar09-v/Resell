"""
Fraud pipeline v2: LightGBM classifier on engineered features with probability
calibration and PR-curve-derived thresholds.

Key changes vs the legacy hand-weighted scorer (services/fraud_detector.py):
- Same-seller relists and cross-seller duplicates are SEPARATE features, not skipped.
- Combined duplicate rule: CLIP embedding similarity is the PRIMARY signal (OR
  logic, ROC-tuned threshold in config); pHash is a fast path for exact/near-
  exact copies only and is never required to agree.
- Price anomaly uses a z-score per category (median + spread) instead of fixed ratios.
- Vision-LLM flags (NVIDIA) are an input feature, fetched only in the uncertainty band.
- Calibrated probability (isotonic, sigmoid fallback) instead of an additive 0-100 score.
- Stages run in parallel with timeouts and rule-based fallbacks.
"""

import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from . import config
from .embedding_cache import get_image_embedding_cached, get_text_embedding_cached
from .vision_llm import analyze_listing_image, in_uncertainty_band

logger = logging.getLogger("ml-service.pipeline.fraud_v2")

FEATURE_ORDER = [
    "max_cross_seller_emb_sim",
    "min_cross_phash_dist",
    "cross_phash_exact",
    "max_same_seller_emb_sim",
    "same_seller_relist",
    "clip_image_text_sim",
    "price_zscore_category",
    "log_account_age_hours",
    "listings_per_hour",
    "aspect_ratio",
    "is_stock_dimensions",
    "has_suspicious_software",
    "vision_llm_flag_count",
    "vision_llm_confidence",
]


def hamming_distance(hash1: str, hash2: str) -> int:
    if not hash1 or not hash2:
        return 64
    try:
        return bin(int(str(hash1), 16) ^ int(str(hash2), 16)).count("1")
    except Exception:
        return sum(c1 != c2 for c1, c2 in zip(str(hash1), str(hash2)))


def _metadata_features(listing: Dict[str, Any], category_median_price: Optional[float]) -> Dict[str, float]:
    metadata = listing.get("metadata", {}) or {}
    width = metadata.get("width") or listing.get("width") or 800
    height = metadata.get("height") or listing.get("height") or 600
    price = float(listing.get("price", 0) or 0)

    cat_median = category_median_price
    if cat_median is None:
        cat_median = listing.get("categoryMedianPrice")
    # Spread from comparables if present, else assume ~35% CV
    spreads = [float(c.get("price", 0)) for c in (listing.get("comparables") or []) if float(c.get("price", 0)) > 0]
    if cat_median is None and spreads:
        cat_median = float(np.median(spreads))
    cat_median = float(cat_median) if cat_median and cat_median > 0 else max(price, 1.0)
    cat_std = float(np.std(spreads)) if len(spreads) > 1 else 0.35 * cat_median
    z = (price - cat_median) / cat_std if cat_std > 0 else 0.0

    account_age_hours = float(listing.get("accountAgeHours", 720) or 720)
    listings_per_hour = float(listing.get("listingsPastHour", listing.get("listingsPerHour", 1)) or 1)

    return {
        "price_zscore_category": float(np.clip(z, -10, 10)),
        "log_account_age_hours": float(np.log1p(max(0, account_age_hours))),
        "listings_per_hour": float(np.log1p(max(0, listings_per_hour))),
        "aspect_ratio": float(width / max(1, height)),
        "is_stock_dimensions": 1.0 if (width in [1920, 1200, 1000] and height in [1080, 800, 1000]) else 0.0,
        "has_suspicious_software": 1.0 if any(
            s in str(metadata.get("software", "")).lower() for s in ["photoshop", "gimp", "canva"]
        ) else 0.0,
    }


def _duplicate_features(listing: Dict[str, Any], candidate_listings: List[Dict[str, Any]]) -> Dict[str, float]:
    """Cross-seller duplicate vs same-seller relist features (separated)."""
    seller_id = str(listing.get("sellerId") or listing.get("seller", "") or "")
    target_phash = str(listing.get("perceptualHash") or "")
    target_emb = listing.get("embedding")

    out = {
        "max_cross_seller_emb_sim": 0.0,
        "min_cross_phash_dist": 64.0,
        "cross_phash_exact": 0.0,
        "max_same_seller_emb_sim": 0.0,
        "same_seller_relist": 0.0,
    }

    t_v = None
    if target_emb and len(target_emb) > 0:
        t_v = np.array(target_emb, dtype=np.float32)
        n = np.linalg.norm(t_v)
        if n > 0:
            t_v = t_v / n
        else:
            t_v = None

    for cand in candidate_listings or []:
        cand_seller = str(cand.get("sellerId") or cand.get("seller", "") or "")
        same_seller = bool(cand_seller and seller_id and cand_seller == seller_id)

        # pHash features
        cand_hashes = cand.get("imageHashes") or [cand.get("perceptualHash")]
        if target_phash:
            for h in cand_hashes:
                if not h:
                    continue
                d = hamming_distance(target_phash, str(h))
                if same_seller:
                    if d <= config.PHASH_EXACT_MAX_DIST * 2:  # relist = looser near-match
                        out["same_seller_relist"] = 1.0
                else:
                    if d < out["min_cross_phash_dist"]:
                        out["min_cross_phash_dist"] = float(d)
                    if d <= config.PHASH_EXACT_MAX_DIST:
                        out["cross_phash_exact"] = 1.0

        # Embedding similarity features
        cand_emb = cand.get("embedding")
        if t_v is not None and cand_emb and len(cand_emb) == len(t_v):
            c_v = np.array(cand_emb, dtype=np.float32)
            n = np.linalg.norm(c_v)
            if n > 0:
                sim = float(np.dot(t_v, c_v / n))
                if same_seller:
                    out["max_same_seller_emb_sim"] = max(out["max_same_seller_emb_sim"], sim)
                else:
                    out["max_cross_seller_emb_sim"] = max(out["max_cross_seller_emb_sim"], sim)

    return out


def extract_fraud_features_v2(
    listing: Dict[str, Any],
    candidate_listings: List[Dict[str, Any]] = None,
    category_median_price: Optional[float] = None,
    image_title_similarity: Optional[float] = None,
    vision_flags: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, float], Dict[str, Any]]:
    """
    Extract the v2 feature dict. Independent stages run in parallel with a
    timeout and rule-based fallbacks. Returns (features, stage_timings).
    """
    timings: Dict[str, float] = {}
    t0 = time.perf_counter()

    def timed(name, fn, *args, **kwargs):
        ts = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            logger.warning(f"Stage {name} failed, using fallback: {e}")
            return None
        finally:
            timings[name] = (time.perf_counter() - ts) * 1000

    dup_fut = None
    meta_fut = None
    sim_fut = None
    results: Dict[str, Any] = {}

    with ThreadPoolExecutor(max_workers=3) as pool:
        dup_fut = pool.submit(timed, "duplicate_features", _duplicate_features,
                              listing, candidate_listings or [])
        meta_fut = pool.submit(timed, "metadata_features", _metadata_features,
                               listing, category_median_price)

        # CLIP image-text similarity (cached, batched path)
        def _title_sim():
            title = listing.get("title")
            img_url = listing.get("imageUrl") or (
                listing.get("images", [{}])[0].get("url") if listing.get("images") else None)
            if not title or not img_url:
                return None
            img_emb = get_image_embedding_cached(img_url)
            txt_emb = get_text_embedding_cached(title)
            if img_emb is None or txt_emb is None:
                return None
            sim = float(np.dot(img_emb, txt_emb))
            return float(max(0.0, min(1.0, (sim + 1.0) / 2.0)))

        sim_fut = pool.submit(timed, "image_text_similarity", _title_sim)

        for name, fut in [("dup", dup_fut), ("meta", meta_fut), ("sim", sim_fut)]:
            try:
                results[name] = fut.result(timeout=config.STAGE_TIMEOUT_S)
            except FutureTimeout:
                logger.warning(f"Stage {name} timed out after {config.STAGE_TIMEOUT_S}s; rule fallback")
                results[name] = None
                fut.cancel()

    dup = results.get("dup") or _duplicate_features(listing, candidate_listings or [])
    meta = results.get("meta") or _metadata_features(listing, category_median_price)
    title_sim = results.get("sim")
    if title_sim is None:
        title_sim = image_title_similarity if image_title_similarity is not None else 0.5

    features = {**dup, **meta}
    features["clip_image_text_sim"] = float(title_sim)
    features["vision_llm_flag_count"] = 0.0
    features["vision_llm_confidence"] = 0.0

    if vision_flags:
        features["vision_llm_flag_count"] = float(len(vision_flags.get("flags", [])))
        features["vision_llm_confidence"] = float(vision_flags.get("confidence", 0.0))

    ordered = {k: float(features.get(k, 0.0)) for k in FEATURE_ORDER}
    timings["total_features_ms"] = (time.perf_counter() - t0) * 1000
    return ordered, timings


# ── Calibrated LightGBM classifier ─────────────────────────────────

class CalibratedFraudClassifier:
    """LightGBM binary classifier + isotonic (or sigmoid) calibration."""

    def __init__(self, model_path: Optional[str] = None, calibrator_path: Optional[str] = None):
        self.model = None
        self.calibrator = None
        if model_path and os.path.exists(model_path):
            try:
                import lightgbm as lgb
                self.model = lgb.Booster(model_file=model_path)
                logger.info(f"Loaded fraud v2 model from {model_path}")
            except Exception as e:
                logger.warning(f"Could not load fraud v2 model: {e}")
        if calibrator_path and os.path.exists(calibrator_path):
            try:
                import pickle
                with open(calibrator_path, "rb") as f:
                    self.calibrator = pickle.load(f)
                logger.info(f"Loaded fraud calibrator from {calibrator_path}")
            except Exception as e:
                logger.warning(f"Could not load calibrator: {e}")

    def is_available(self) -> bool:
        return self.model is not None

    def predict_proba(self, features: Dict[str, float]) -> Optional[float]:
        if self.model is None:
            return None
        X = np.array([[features.get(k, 0.0) for k in FEATURE_ORDER]], dtype=np.float32)
        raw = float(self.model.predict(X)[0])
        if self.calibrator is not None:
            try:
                return float(np.clip(self.calibrator.predict([raw])[0], 0.0, 1.0))
            except Exception as e:
                logger.warning(f"Calibration failed ({e}); using raw score")
        return float(np.clip(raw, 0.0, 1.0))


classifier = CalibratedFraudClassifier(config.FRAUD_MODEL_PATH, config.FRAUD_CALIBRATOR_PATH)


def load_thresholds() -> Dict[str, float]:
    """Runtime thresholds: persisted PR-curve values (models_saved/
    fraud_v2_thresholds.json, currently 0.95 flag / 0.475 review) win over
    the config env defaults (0.60 / 0.30) when the file exists. v2 output
    is shadow-only — the backend v1 scorer owns listing status."""
    try:
        with open(config.FRAUD_THRESHOLDS_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {
            "flag_threshold": config.FRAUD_HIGH_THRESHOLD,
            "review_threshold": config.FRAUD_MEDIUM_THRESHOLD,
        }


def evaluate_fraud_risk_v2(
    listing: Dict[str, Any],
    candidate_listings: List[Dict[str, Any]] = None,
    category_median_price: Optional[float] = None,
    image_title_similarity: Optional[float] = None,
) -> Dict[str, Any]:
    """
    v2 fraud pipeline. Returns the same response shape as the legacy endpoint
    (fraudScore 0-100, riskLevel, isFlagged, reasons, signals) so the backend
    can switch via feature flag without contract changes, plus v2 extras.
    """
    t0 = time.perf_counter()
    thresholds = load_thresholds()

    # Stage 1: features (parallel, timeout-guarded)
    features, timings = extract_fraud_features_v2(
        listing, candidate_listings, category_median_price, image_title_similarity
    )

    # Stage 2: calibrated model probability
    prob = classifier.predict_proba(features)
    timings["model_ms"] = (time.perf_counter() - t0) * 1000

    # Stage 3: vision-LLM ONLY inside the tuned uncertainty band
    if prob is not None and in_uncertainty_band(prob):
        img_url = listing.get("imageUrl") or (
            listing.get("images", [{}])[0].get("url") if listing.get("images") else None)
        vf = analyze_listing_image(img_url)
        if vf is not None:
            timings["vision_llm_ms"] = vf.get("latency_ms", 0.0)
            features["vision_llm_flag_count"] = float(len(vf.get("flags", [])))
            features["vision_llm_confidence"] = float(vf.get("confidence", 0.0))
            prob = classifier.predict_proba(features) or prob
            timings["re_score_ms"] = (time.perf_counter() - t0) * 1000

    # Rule-based fallback when no trained model is available
    if prob is None:
        prob = _rule_fallback_score(features)

    # Convert to legacy 0-100 scale + reasons
    score_100 = round(prob * 100.0, 1)
    reasons, signals = _build_reasons(features, prob)

    flag_t = float(thresholds.get("flag_threshold", config.FRAUD_HIGH_THRESHOLD))
    review_t = float(thresholds.get("review_threshold", config.FRAUD_MEDIUM_THRESHOLD))

    if prob >= flag_t:
        risk_level, status_rec = "high", "pendingReview"
    elif prob >= review_t:
        risk_level, status_rec = "medium", "active"
    else:
        risk_level, status_rec = "low", "active"

    return {
        "fraudScore": score_100,
        "riskLevel": risk_level,
        "isFlagged": prob >= flag_t,
        "statusRecommendation": status_rec,
        "fraudProbability": round(prob, 4),
        "fraudReasons": reasons,
        "signals": signals,
        "features": features,
        "stageTimingsMs": {k: round(v, 2) for k, v in timings.items()},
        "pipelineVersion": "v2",
        "thresholds": {"flag": flag_t, "review": review_t},
    }


def duplicate_detected(features: Dict[str, float]) -> Tuple[bool, str]:
    """
    Combined cross-seller duplicate rule.
    - PRIMARY signal: CLIP embedding similarity (OR logic) against
      config.DUPLICATE_EMB_SIM_THRESHOLD, chosen from the ROC curve at 2% FPR
      on the adversarial duplicate set.
    - pHash is a FAST PATH only: exact or near-exact copies (low Hamming
      distance). pHash agreement is never required for the embedding signal.
    Returns (detected, primary_signal) where primary_signal is
    "embedding" | "phash" | "none".
    """
    thr = config.DUPLICATE_EMB_SIM_THRESHOLD
    emb_hit = float(features.get("max_cross_seller_emb_sim", 0.0)) >= thr
    phash_hit = (float(features.get("cross_phash_exact", 0.0)) == 1.0
                 or float(features.get("min_cross_phash_dist", 64.0)) <= config.PHASH_EXACT_MAX_DIST)
    if emb_hit:
        return True, "embedding"
    if phash_hit:
        return True, "phash"
    return False, "none"


def _rule_fallback_score(f: Dict[str, float]) -> float:
    """Rule-based fallback (mirrors the combined duplicate rule) when the model is unavailable."""
    score = 0.0
    thr = config.DUPLICATE_EMB_SIM_THRESHOLD
    # PRIMARY: CLIP embedding similarity (OR logic)
    if f["max_cross_seller_emb_sim"] >= thr:
        score += 0.55
    elif f["max_cross_seller_emb_sim"] >= thr - 0.06:
        score += 0.20
    # FAST PATH: pHash exact / near-exact copies only (never required)
    if f["cross_phash_exact"] == 1:
        score += 0.30
    elif f["min_cross_phash_dist"] <= config.PHASH_EXACT_MAX_DIST:
        score += 0.20
    if f["clip_image_text_sim"] < 0.18:
        score += 0.25
    if f["has_suspicious_software"] == 1:
        score += 0.15
    if f["price_zscore_category"] < -2.5:
        score += 0.25
    if f["log_account_age_hours"] < np.log1p(48) and f["listings_per_hour"] > np.log1p(6):
        score += 0.30
    if f["same_seller_relist"] == 1:
        score = min(score, 0.35)  # same-seller relists are capped, not fraud
    return float(np.clip(score, 0.0, 1.0))


def _build_reasons(f: Dict[str, float], prob: float) -> Tuple[List[str], Dict[str, Any]]:
    reasons, signals = [], {}
    if f["cross_phash_exact"] == 1:
        reasons.append("Cross-seller duplicate image (perceptual hash exact match)")
        signals["cross_seller_phash"] = {"detected": True, "distance": int(f["min_cross_phash_dist"])}
    elif f["min_cross_phash_dist"] <= 8:
        reasons.append(f"Near-duplicate image from another seller (Hamming distance: {int(f['min_cross_phash_dist'])})")
        signals["cross_seller_phash"] = {"detected": True, "distance": int(f["min_cross_phash_dist"])}

    if f["max_cross_seller_emb_sim"] >= config.DUPLICATE_EMB_SIM_THRESHOLD:
        reasons.append(f"High visual similarity to another seller's listing ({f['max_cross_seller_emb_sim']*100:.1f}%)")
        signals["cross_seller_vector"] = {"detected": True, "similarity": round(f["max_cross_seller_emb_sim"], 3)}

    detected, primary = duplicate_detected(f)
    if detected:
        signals["combined_duplicate"] = {
            "detected": True,
            "primarySignal": primary,
            "embeddingSim": round(f["max_cross_seller_emb_sim"], 3),
            "embeddingThreshold": round(config.DUPLICATE_EMB_SIM_THRESHOLD, 3),
            "minPhashDist": int(f["min_cross_phash_dist"]),
        }

    if f["same_seller_relist"] == 1:
        signals["same_seller_relist"] = {"detected": True,
                                         "max_sim": round(f["max_same_seller_emb_sim"], 3)}
        reasons.append("Same-seller relist detected (not treated as cross-seller fraud)")

    if f["clip_image_text_sim"] < 0.18:
        reasons.append(f"Image does not match product title (semantic relevance: {f['clip_image_text_sim']:.2f})")
        signals["title_image_mismatch"] = {"detected": True}

    if f["vision_llm_flag_count"] > 0:
        reasons.append(f"Vision model flags: {int(f['vision_llm_flag_count'])}")
        signals["vision_llm"] = {"flags": int(f["vision_llm_flag_count"]),
                                 "confidence": round(f["vision_llm_confidence"], 2)}

    if f["price_zscore_category"] < -2.5:
        reasons.append(f"Price far below category norm (z-score: {f['price_zscore_category']:.1f})")
        signals["price_anomaly"] = {"too_low": True, "zscore": round(f["price_zscore_category"], 2)}
    elif f["price_zscore_category"] > 3.0:
        signals["price_anomaly"] = {"too_high": True, "zscore": round(f["price_zscore_category"], 2)}

    if f["log_account_age_hours"] < np.log1p(48) and f["listings_per_hour"] > np.log1p(6):
        reasons.append(f"New account with high listing velocity ({int(np.expm1(f['listings_per_hour']))}/hour)")
        signals["high_velocity_new_account"] = True

    signals["model_probability"] = round(prob, 4)
    return reasons, signals
