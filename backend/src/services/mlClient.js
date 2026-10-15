/**
 * ML Service HTTP Client
 * Connects the Node.js backend to the Python FastAPI ML microservice.
 * Provides functions for CLIP embeddings, multi-modal fraud detection, and price estimation.
 */

const axios = require('axios');

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_TIMEOUT = 15000;

const client = axios.create({
  baseURL: ML_SERVICE_URL,
  timeout: DEFAULT_TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Check health / availability of the ML microservice
 */
async function checkHealth() {
  try {
    const res = await client.get('/health', { timeout: 3000 });
    return res.data?.status === 'healthy';
  } catch (err) {
    return false;
  }
}

/**
 * Extract 512-D CLIP embedding for a single image URL
 */
async function getEmbedding(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await client.post('/embed', { imageUrl });
    if (res.data?.success && Array.isArray(res.data.embedding)) {
      return res.data.embedding;
    }
    return null;
  } catch (err) {
    console.warn(`[MLClient] Embedding extraction failed for ${imageUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Embed a single piece of text with the ML service's CLIP text encoder.
 * Used for near-duplicate description detection (fraudDetection.js).
 * Returns null (never throws) when the ML service is unavailable — callers
 * fall back to the pure-JS n-gram similarity instead.
 */
async function getTextEmbedding(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    const res = await client.post('/text-embed', { text }, { timeout: 5000 });
    if (res.data?.success && Array.isArray(res.data.embedding)) {
      return res.data.embedding;
    }
    return null;
  } catch (err) {
    console.warn(`[MLClient] Text embedding failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract 512-D CLIP embeddings for multiple image URLs
 */
async function getBatchEmbeddings(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return [];
  try {
    const res = await client.post('/embed', { imageUrls });
    if (res.data?.success && Array.isArray(res.data.results)) {
      return res.data.results;
    }
    return [];
  } catch (err) {
    console.warn(`[MLClient] Batch embedding failed: ${err.message}`);
    return [];
  }
}

/**
 * Perform comprehensive multi-modal fraud check
 * @param {Object} listing - Target listing { _id, title, price, seller, perceptualHash, embedding, etc. }
 * @param {Array} candidateListings - Other listings for comparison
 * @param {Number} categoryMedianPrice - Optional category median
 */
async function checkFraud({ listing, candidateListings = [], categoryMedianPrice = null }) {
  try {
    const res = await client.post('/fraud-check', {
      listing,
      candidateListings,
      categoryMedianPrice,
    });
    return res.data;
  } catch (err) {
    console.warn(`[MLClient] Fraud check failed, falling back to rule engine: ${err.message}`);
    return {
      fraudScore: 0,
      riskLevel: 'low',
      isFlagged: false,
      statusRecommendation: 'active',
      fraudReasons: [],
      signals: {},
      error: err.message,
    };
  }
}

/**
 * Estimate fair price, price intervals (min, max, p25, p75) via kNN embeddings
 * @param {Object} listing - Target listing metadata
 * @param {Array} embedding - 512-D vector
 * @param {Array} comparables - Category listings
 */
async function estimatePrice({ listing, embedding = null, imageUrl = null, comparables = [], kNeighbors = 5 }) {
  try {
    const res = await client.post('/price-estimate', {
      listing,
      embedding,
      imageUrl,
      comparables,
      kNeighbors,
    });
    return res.data;
  } catch (err) {
    console.warn(`[MLClient] Price estimate failed, using local baseline: ${err.message}`);
    return null;
  }
}

// Share of the final price given to the ML estimate when both it and the
// local heuristic are available (0..1). 0.7 = 70% ML / 30% local heuristic.
const DEFAULT_ML_BLEND_WEIGHT = Number(process.env.ML_BLEND_WEIGHT ?? 0.7);

const clampWeight = (w) => {
  const n = Number(w);
  if (!Number.isFinite(n)) return clampWeight(DEFAULT_ML_BLEND_WEIGHT);
  return Math.max(0, Math.min(1, n));
};

/**
 * Weighted blend of the transparent local heuristic price with the ML kNN
 * estimate. Both imageProcessor and priceAnalyzer use this so the ML value
 * is never wholesale-overridden nor silently clobbered by a later local-only
 * recompute. Falls back to whichever side is available.
 *
 * @param {Object} local  priceRecommendation-calulateRecommendedPrice result
 * @param {Object} ml     ml-service /price-estimate response (suggestedPrice, priceRange)
 * @param {number} [weight] ML share, defaults to ML_BLEND_WEIGHT (0.7)
 */
function blendWithMl(local, ml, weight = DEFAULT_ML_BLEND_WEIGHT) {
  const w = clampWeight(weight);
  const mlPrice = ml && (typeof ml.suggestedPrice === 'number' || typeof ml.suggestedPrice === 'string')
    ? Number(ml.suggestedPrice)
    : NaN;
  const hasMl = Number.isFinite(mlPrice) && mlPrice > 0;

  if (!hasMl) {
    if (!local) return null;
    return { ...local, source: local.source || 'heuristic' };
  }
  if (!local || !(local.recommendedPrice > 0)) {
    return {
      recommendedPrice: mlPrice,
      minPrice: ml.priceRange?.min ?? 0,
      maxPrice: ml.priceRange?.max ?? 0,
      confidence: ml.confidence ?? 0,
      explanation: ml.explanation || 'Price estimated by ML (no local baseline available)',
      factors: ml.factors || [],
      source: 'ml-service',
    };
  }

  const blend = (a, b) => (a == null ? b : b == null ? a : a * (1 - w) + b * w);
  return {
    recommendedPrice: local.recommendedPrice * (1 - w) + mlPrice * w,
    minPrice: blend(local.minPrice, ml.priceRange?.min),
    maxPrice: blend(local.maxPrice, ml.priceRange?.max),
    confidence: local.confidence,
    explanation: `Blended ${Math.round(w * 100)}% ML / ${Math.round((1 - w) * 100)}% local heuristic${
      ml.explanation ? ' — ' + ml.explanation : ''
    }`,
    factors: [
      ...(Array.isArray(local.factors) ? local.factors : []),
      `ML kNN estimate ${mlPrice.toFixed(2)} blended at ${Math.round(w * 100)}% weight`,
    ],
    source: 'hybrid',
  };
}

/**
 * Attach a later human outcome (appeal decided, report resolved) to a logged
 * prediction so the ML pipeline can learn from true vs. false positives.
 *
 * The ml-service keys fraud predictions by the listing `_id` and only applies
 * the outcome to a record that still has `outcome: null` — so this is always
 * a no-op when no matching prediction was logged.
 *
 * Degrades gracefully: ML being unavailable must never break the request
 * that produced the human decision, so failures are swallowed and reported
 * via the return value.
 *
 * @param {Object} params
 * @param {string} params.recordId  Listing/product `_id` the prediction was keyed by
 * @param {Object} params.outcome   e.g. { decided: 'confirmed_fraud' } or
 *                                  { decided: 'false_positive', disputedFactors: [...] }
 * @returns {Promise<boolean>} true when the ml-service reported the outcome was attached
 */
async function sendOutcomeFeedback({ recordId, outcome }) {
  if (!recordId || !outcome) return false;
  try {
    const res = await client.post('/feedback', { recordId, outcome });
    return Boolean(res.data?.success);
  } catch (err) {
    console.warn(`[MLClient] Outcome feedback not delivered: ${err.message}`);
    return false;
  }
}

module.exports = {
  checkHealth,
  getEmbedding,
  getBatchEmbeddings,
  getTextEmbedding,
  checkFraud,
  estimatePrice,
  blendWithMl,
  sendOutcomeFeedback,
  DEFAULT_ML_BLEND_WEIGHT,
  ML_SERVICE_URL,
};
