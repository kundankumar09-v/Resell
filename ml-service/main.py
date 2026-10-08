"""
ReSell Machine Learning Microservice
FastAPI Application serving:
  - CLIP (ViT-B/32) Image & Text 512-D Embeddings
  - Multi-Modal Fraud Detection & Risk Scoring
  - kNN & LightGBM Quantile Price Estimation
  - Legacy CNN/SIFT Verification Endpoints
"""

import os
import time
import logging
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from models.clip_model import (
    initialize_clip,
    is_model_loaded,
    extract_image_embedding,
    extract_text_embedding,
    compute_image_text_similarity
)
from services.fraud_detector import evaluate_fraud_risk
from services.price_estimator import estimate_price_knn

# ── Pipeline v2 (feature-flagged upgrade; ML_PIPELINE_V2=1 to enable) ──
from pipeline import config as pipeline_config
from pipeline.fraud_v2 import evaluate_fraud_risk_v2
from pipeline.price_v2 import evaluate_price_v2
from pipeline.ann_index import ann_index
from pipeline.logging_store import log_prediction, record_outcome, drift_report
from pipeline.embedding_cache import cache_stats as embed_cache_stats
import uuid

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("ml-service")

app = FastAPI(
    title="ReSell ML Microservice",
    description="CLIP Embeddings, Multi-Modal Fraud Risk & Quantile Price Estimation API",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic Request/Response Models ───────────────────────────────

class EmbedImageRequest(BaseModel):
    imageUrl: Optional[str] = None
    imageUrls: Optional[List[str]] = None

class EmbedTextRequest(BaseModel):
    text: str

class FraudCheckRequest(BaseModel):
    listing: Dict[str, Any] = Field(..., description="Target listing metadata, price, seller, embedding, pHash")
    candidateListings: Optional[List[Dict[str, Any]]] = Field(default=[], description="Other listings for duplicate/similarity check")
    categoryMedianPrice: Optional[float] = None
    embeddingSimilarityThreshold: Optional[float] = 0.88
    phashDistanceThreshold: Optional[int] = 8

class PriceEstimateRequest(BaseModel):
    listing: Dict[str, Any] = Field(..., description="Target listing with condition, originalPrice, yearsUsed, category")
    embedding: Optional[List[float]] = None
    imageUrl: Optional[str] = None
    comparables: Optional[List[Dict[str, Any]]] = Field(default=[], description="Historical sold/active listings in category")
    kNeighbors: Optional[int] = 5


# ── Lifespan Startup ───────────────────────────────────────────────

@app.on_event("startup")
def startup_event():
    model_name = os.environ.get("CLIP_MODEL_NAME", "ViT-B-32")
    pretrained = os.environ.get("CLIP_PRETRAINED", "laion2b_s34b_b79k")
    logger.info("Initializing ML Service & loading CLIP model...")
    initialize_clip(model_name=model_name, pretrained=pretrained)
    if pipeline_config.ML_PIPELINE_V2:
        logger.info("ML_PIPELINE_V2 feature flag ENABLED - serving calibrated "
                    "LightGBM fraud + quantile price pipeline")
        if ann_index.load():
            logger.info("Persistent HNSW ANN index restored from disk")
    elif pipeline_config.ML_PIPELINE_SHADOW:
        logger.info("ML_PIPELINE_V2=shadow - running BOTH pipelines per request: "
                    "legacy results are SERVED, both outputs are logged for comparison")
        if ann_index.load():
            logger.info("Persistent HNSW ANN index restored from disk")
    else:
        logger.info("ML_PIPELINE_V2 disabled - serving legacy rule/heuristic pipeline")


# ── Health Endpoint ────────────────────────────────────────────────

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "resell-ml-service",
        "clip_loaded": is_model_loaded(),
        "pipelineVersion": ("v2" if pipeline_config.ML_PIPELINE_V2
                            else "shadow" if pipeline_config.ML_PIPELINE_SHADOW else "legacy"),
        "featureFlag": {"ml_pipeline_v2": pipeline_config.ML_PIPELINE_V2,
                        "shadow_mode": pipeline_config.ML_PIPELINE_SHADOW},
        "timestamp": time.time()
    }


@app.get("/pipeline-stats")
def pipeline_stats():
    """Runtime stats for the v2 pipeline (ANN index, embedding cache, drift)."""
    stats = {
        "pipelineVersion": ("v2" if pipeline_config.ML_PIPELINE_V2
                            else "shadow" if pipeline_config.ML_PIPELINE_SHADOW else "legacy"),
        "embeddingCache": embed_cache_stats(),
        "annIndex": ann_index.stats(),
    }
    try:
        stats["drift"] = drift_report()
    except Exception as e:
        stats["drift"] = {"error": str(e)}
    return stats


@app.post("/feedback")
def feedback_endpoint(req: Dict[str, Any]):
    """Attach a later outcome (admin decision, sold price) to a logged prediction."""
    record_id = req.get("recordId")
    outcome = req.get("outcome") or {}
    if not record_id or not outcome:
        raise HTTPException(status_code=400, detail="recordId and outcome are required")
    updated = record_outcome(record_id, outcome)
    return {"success": updated, "recordId": record_id}


# ── 1. Embedding Endpoint ──────────────────────────────────────────

@app.post("/embed")
def embed_image_endpoint(req: EmbedImageRequest):
    """
    Generate 512-dimensional normalized CLIP embedding for image URL(s).
    """
    start_t = time.time()
    if req.imageUrl:
        try:
            emb = extract_image_embedding(req.imageUrl)
            return {
                "success": True,
                "imageUrl": req.imageUrl,
                "embedding": emb.tolist(),
                "dimension": len(emb),
                "processing_time_ms": round((time.time() - start_t) * 1000, 2)
            }
        except Exception as e:
            logger.error(f"Failed to embed image {req.imageUrl}: {e}")
            raise HTTPException(status_code=400, detail=f"Failed to extract image embedding: {str(e)}")

    elif req.imageUrls:
        results = []
        for url in req.imageUrls:
            try:
                emb = extract_image_embedding(url)
                results.append({
                    "imageUrl": url,
                    "embedding": emb.tolist(),
                    "dimension": len(emb),
                    "success": True
                })
            except Exception as e:
                results.append({
                    "imageUrl": url,
                    "embedding": [],
                    "dimension": 0,
                    "error": str(e),
                    "success": False
                })
        return {
            "success": True,
            "results": results,
            "processing_time_ms": round((time.time() - start_t) * 1000, 2)
        }
    else:
        raise HTTPException(status_code=400, detail="Either imageUrl or imageUrls is required")


@app.post("/text-embed")
def embed_text_endpoint(req: EmbedTextRequest):
    """
    Generate 512-dimensional normalized CLIP text embedding.
    """
    start_t = time.time()
    try:
        emb = extract_text_embedding(req.text)
        return {
            "success": True,
            "text": req.text,
            "embedding": emb.tolist(),
            "dimension": len(emb),
            "processing_time_ms": round((time.time() - start_t) * 1000, 2)
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Text embedding failed: {str(e)}")


# ── Shadow mode helpers ────────────────────────────────────────────

_SHADOW_KEYS = ("fraudScore", "fraudProbability", "riskLevel", "isFlagged",
                "suggestedPrice", "confidence", "source", "statusRecommendation")


def _log_shadow_pair(kind: str, listing: Dict[str, Any],
                     served: Dict[str, Any], shadow: Dict[str, Any]):
    """
    Log BOTH pipeline outputs for one request so later outcomes (admin
    decisions, sold prices) attach to both records via the shared id and the
    legacy-vs-v2 comparison is direct.
    """
    record_id = (listing.get("id") or listing.get("_id") or str(uuid.uuid4()))
    inputs = {"sellerId": listing.get("sellerId"),
              "price": listing.get("price"),
              "category": listing.get("category")}
    try:
        served_out = {k: served.get(k) for k in _SHADOW_KEYS if served.get(k) is not None}
        served_out.update({"served": True, "pipelineVersion": "legacy"})
        log_prediction(kind, record_id, inputs, served.get("features", {}) or {}, served_out)

        shadow_out = {k: shadow.get(k) for k in _SHADOW_KEYS if shadow.get(k) is not None}
        shadow_out.update({"shadow": True, "pipelineVersion": "v2"})
        log_prediction(kind, record_id, inputs, shadow.get("features", {}) or {}, shadow_out)
    except Exception as log_err:
        logger.warning(f"Shadow prediction logging failed: {log_err}")


# ── 2. Fraud & Risk Check Endpoint ─────────────────────────────────

@app.post("/fraud-check")
def fraud_check_endpoint(req: FraudCheckRequest):
    """
    Multi-modal fraud check combining:
      - pHash match
      - Vector nearest-neighbor similarity
      - Image vs title semantic similarity
      - EXIF / metadata indicators
      - Price anomaly & account age / listing velocity
    """
    start_t = time.time()
    try:
        listing = req.listing

        if pipeline_config.ML_PIPELINE_SHADOW:
            # ── Shadow mode: run BOTH, serve legacy, log both ──
            title_sim = None
            title = listing.get("title")
            img_url = listing.get("imageUrl") or (listing.get("images", [{}])[0].get("url") if listing.get("images") else None)
            if title and img_url:
                try:
                    title_sim = compute_image_text_similarity(img_url, title)
                except Exception as e:
                    logger.warning(f"Image-title similarity check failed: {e}")

            legacy_result = evaluate_fraud_risk(
                listing=listing,
                candidate_listings=req.candidateListings,
                image_title_similarity=title_sim,
                category_median_price=req.categoryMedianPrice,
                emb_sim_threshold=req.embeddingSimilarityThreshold,
                phash_dist_threshold=req.phashDistanceThreshold
            )
            legacy_result["processing_time_ms"] = round((time.time() - start_t) * 1000, 2)

            try:
                v2_result = evaluate_fraud_risk_v2(
                    listing=listing,
                    candidate_listings=req.candidateListings,
                    category_median_price=req.categoryMedianPrice,
                )
            except Exception as v2_err:
                logger.warning(f"Shadow v2 fraud evaluation failed: {v2_err}")
                v2_result = {"error": str(v2_err)}

            _log_shadow_pair("fraud", listing, legacy_result, v2_result)
            return legacy_result

        if pipeline_config.ML_PIPELINE_V2:
            # ── v2 pipeline: calibrated LightGBM + PR thresholds ──
            result = evaluate_fraud_risk_v2(
                listing=listing,
                candidate_listings=req.candidateListings,
                category_median_price=req.categoryMedianPrice,
            )
            result["processing_time_ms"] = round((time.time() - start_t) * 1000, 2)
            try:
                log_prediction("fraud", listing.get("id") or listing.get("_id") or str(uuid.uuid4()),
                               {"sellerId": listing.get("sellerId"),
                                "price": listing.get("price"),
                                "category": listing.get("category")},
                               result.get("features", {}),
                               {"fraudScore": result.get("fraudScore"),
                                "fraudProbability": result.get("fraudProbability"),
                                "riskLevel": result.get("riskLevel"),
                                "isFlagged": result.get("isFlagged")})
            except Exception as log_err:
                logger.warning(f"Prediction logging failed: {log_err}")
            return result

        # ── Legacy pipeline (unchanged) ───────────────────────────
        # Calculate image vs title similarity if imageUrl/embedding and title are available
        title_sim = None
        title = listing.get("title")
        img_url = listing.get("imageUrl") or (listing.get("images", [{}])[0].get("url") if listing.get("images") else None)
        
        if title and img_url:
            try:
                title_sim = compute_image_text_similarity(img_url, title)
            except Exception as e:
                logger.warning(f"Image-title similarity check failed: {e}")

        result = evaluate_fraud_risk(
            listing=listing,
            candidate_listings=req.candidateListings,
            image_title_similarity=title_sim,
            category_median_price=req.categoryMedianPrice,
            emb_sim_threshold=req.embeddingSimilarityThreshold,
            phash_dist_threshold=req.phashDistanceThreshold
        )
        result["processing_time_ms"] = round((time.time() - start_t) * 1000, 2)
        return result
    except Exception as e:
        logger.error(f"Fraud check error: {e}")
        raise HTTPException(status_code=500, detail=f"Fraud evaluation failed: {str(e)}")


# ── 3. Price Estimation Endpoint ───────────────────────────────────

@app.post("/price-estimate")
def price_estimate_endpoint(req: PriceEstimateRequest):
    """
    Estimate fair market price and uncertainty intervals (p25, median, p75)
    via embedding kNN and quantile modeling.
    """
    start_t = time.time()
    try:
        target_embedding = req.embedding
        if not target_embedding and req.imageUrl:
            try:
                target_embedding = extract_image_embedding(req.imageUrl).tolist()
            except Exception as e:
                logger.warning(f"Could not extract embedding from imageUrl: {e}")

        if pipeline_config.ML_PIPELINE_SHADOW:
            # ── Shadow mode: run BOTH, serve legacy, log both ──
            legacy_result = estimate_price_knn(
                target_embedding=target_embedding,
                target_metadata=req.listing,
                comparables=req.comparables or [],
                k_neighbors=req.kNeighbors or 5
            )
            legacy_result["processing_time_ms"] = round((time.time() - start_t) * 1000, 2)
            try:
                v2_result = evaluate_price_v2(
                    req.listing,
                    req.comparables or [],
                    target_embedding=target_embedding,
                    k_neighbors=req.kNeighbors,
                )
            except Exception as v2_err:
                logger.warning(f"Shadow v2 price evaluation failed: {v2_err}")
                v2_result = {"error": str(v2_err)}

            _log_shadow_pair("price", req.listing, legacy_result, v2_result)
            return legacy_result

        if pipeline_config.ML_PIPELINE_V2:
            # ── v2 pipeline: quantile regression + conformal intervals ──
            result = evaluate_price_v2(
                req.listing,
                req.comparables or [],
                target_embedding=target_embedding,
                k_neighbors=req.kNeighbors,
            )
            result["processing_time_ms"] = round((time.time() - start_t) * 1000, 2)
            try:
                log_prediction("price", req.listing.get("id") or req.listing.get("_id") or str(uuid.uuid4()),
                               {"category": req.listing.get("category"),
                                "condition": req.listing.get("condition"),
                                "originalPrice": req.listing.get("originalPrice")},
                               result.get("features", {}),
                               {"suggestedPrice": result.get("suggestedPrice"),
                                "confidence": result.get("confidence"),
                                "source": result.get("source")})
            except Exception as log_err:
                logger.warning(f"Prediction logging failed: {log_err}")
            return result

        result = estimate_price_knn(
            target_embedding=target_embedding,
            target_metadata=req.listing,
            comparables=req.comparables or [],
            k_neighbors=req.kNeighbors or 5
        )
        result["processing_time_ms"] = round((time.time() - start_t) * 1000, 2)
        return result
    except Exception as e:
        logger.error(f"Price estimate error: {e}")
        raise HTTPException(status_code=500, detail=f"Price estimation failed: {str(e)}")


# ── 4. Backward Compatibility Endpoints ───────────────────────────

@app.post("/extract-cnn")
def extract_cnn_compat(req: Dict[str, Any]):
    """Compatibility endpoint for existing code calling /extract-cnn"""
    image_url = req.get("imageUrl")
    if not image_url:
        raise HTTPException(status_code=400, detail="imageUrl is required")
    try:
        emb = extract_image_embedding(image_url)
        return {
            "features": emb.tolist(),
            "feature_dim": len(emb),
            "product_type": "general",
            "processing_time_ms": 10.0
        }
    except Exception as e:
        return {"error": str(e), "features": [], "feature_dim": 0, "product_type": "unknown"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting ReSell ML FastAPI service on port {port}...")
    uvicorn.run(app, host="0.0.0.0", port=port)
