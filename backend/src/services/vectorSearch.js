/**
 * Vector Search Service
 * Implements MongoDB Atlas Vector Search ($vectorSearch with cosine similarity)
 * with an automatic fallback to in-memory cosine similarity kNN when running
 * on local MongoDB Community instances without Atlas Search.
 */

const Product = require('../models/Product');

/**
 * MongoDB Atlas Vector Search Index definition specification:
 * Index name: "vector_index"
 * Field: "embedding"
 * Dimensions: 512
 * Similarity: "cosine"
 * 
 * Atlas JSON definition:
 * {
 *   "fields": [
 *     {
 *       "type": "vector",
 *       "path": "embedding",
 *       "numDimensions": 512,
 *       "similarity": "cosine"
 *     },
 *     {
 *       "type": "filter",
 *       "path": "category"
 *     },
 *     {
 *       "type": "filter",
 *       "path": "status"
 *     }
 *   ]
 * }
 */
const ATLAS_VECTOR_INDEX_NAME = 'vector_index';

/**
 * Compute cosine similarity between two float vectors
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Search nearest neighbors by vector embedding
 * @param {Array<Number>} queryVector - 512-D float array
 * @param {Object} options - { limit, category, status, excludeId, crossCategory }
 *   crossCategory: ignore `category` and search platform-wide (used by the
 *   cross-category CLIP image-repost scan in fraudDetection.js).
 */
async function searchVectorNearestNeighbors(queryVector, options = {}) {
  const {
    limit = 10,
    category = null,
    status = 'active',
    excludeId = null,
    crossCategory = false,
  } = options;
  const useCategory = !crossCategory && !!category;

  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    return [];
  }

  // Attempt Atlas $vectorSearch pipeline first
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: ATLAS_VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector,
          numCandidates: limit * 10,
          limit,
          filter: {
            ...(useCategory ? { category: { $eq: category } } : {}),
            ...(status ? { status: { $eq: status } } : {}),
          },
        },
      },
      {
        $project: {
          title: 1,
          price: 1,
          originalPrice: 1,
          condition: 1,
          category: 1,
          seller: 1,
          images: 1,
          embedding: 1,
          status: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    if (excludeId) {
      pipeline.push({ $match: { _id: { $ne: excludeId } } });
    }

    const atlasResults = await Product.aggregate(pipeline);
    if (atlasResults && atlasResults.length > 0) {
      return atlasResults;
    }
  } catch (atlasErr) {
    // Atlas vector search unavailable (expected on local MongoDB / memory server)
    // Fall back seamlessly to in-memory cosine kNN
  }

  // Local In-Memory / Mongoose Cosine Fallback
  const filter = {
    embedding: { $exists: true, $ne: [] },
  };
  if (status) filter.status = status;
  if (useCategory) filter.category = category;
  if (excludeId) filter._id = { $ne: excludeId };

  const candidates = await Product.find(filter)
    .select('title price originalPrice condition category seller images embedding status createdAt')
    .limit(300)
    .lean();

  const scored = candidates
    .map((product) => {
      const score = cosineSimilarity(queryVector, product.embedding);
      return { ...product, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

module.exports = {
  searchVectorNearestNeighbors,
  cosineSimilarity,
  ATLAS_VECTOR_INDEX_NAME,
};
