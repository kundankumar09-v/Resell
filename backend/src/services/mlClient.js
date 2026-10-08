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

module.exports = {
  checkHealth,
  getEmbedding,
  getBatchEmbeddings,
  checkFraud,
  estimatePrice,
  ML_SERVICE_URL,
};
