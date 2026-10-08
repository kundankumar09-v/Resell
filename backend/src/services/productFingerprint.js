/**
 * Product Fingerprint Service (SCRUM-25)
 *
 * Builds a visual fingerprint of a physical product from the CNN
 * (MobileNet) features already extracted by the existing image
 * processing pipeline (Product.images[].cnnFeatures). This is
 * complementary to pHash (image duplicate detection) and to
 * identifier-based identity:
 *
 *   pHash              -> identical / near-duplicate IMAGES
 *   CNN fingerprint    -> physical APPEARANCE similarity
 *   Identifier         -> registry identity when available
 *   Possession         -> seller possession evidence
 *   Fraud engine       -> combined risk assessment
 *
 * Key semantics:
 *   - Same brand + model is NOT fraud (two sellers may legitimately own
 *     the same model).
 *   - High visual similarity is a SUPPORTING risk signal only, never
 *     proof that two listings are the same physical item.
 *   - Comparisons are crosswise (every image in A vs every image in B),
 *     so identical camera angles are NOT required.
 *   - When CNN features are unavailable the result is explicitly
 *     `available: false` — unavailable ML is never treated as fraud.
 *
 * Uses actual image features from the existing ML pipeline — never
 * filenames, URLs, or client-provided hashes.
 */

// Thresholds are configurable via environment variables with sane defaults.
// Medium: strong enough to be a supporting signal while staying well below
// "definitely the same item". Strong: very high similarity — still only a
// supporting signal, combined with other evidence by the fraud engine.
const envNum = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const MEDIUM_SIMILARITY_THRESHOLD = envNum('VISUAL_SIMILARITY_MEDIUM_THRESHOLD', 0.9);
const STRONG_SIMILARITY_THRESHOLD = envNum('VISUAL_SIMILARITY_STRONG_THRESHOLD', 0.97);

// Maximum number of candidate listings to compare against, keeping the
// crosswise comparison bounded.
const MAX_CANDIDATES = 200;

/**
 * Cosine similarity between two numeric vectors.
 * Returns null when either vector is invalid (missing, empty, or a
 * length mismatch) so callers can skip invalid pairs cleanly.
 */
const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return null;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  // Clamp to [0, 1] — negative cosine (rare for CNN embeddings) carries no
  // positive similarity meaning.
  return Math.max(0, Math.min(1, dot / denom));
};

/**
 * Collect valid per-image feature vectors from a product (or plain
 * object with images[].cnnFeatures).
 */
const validImageFeatures = (product) => {
  const images = Array.isArray(product?.images) ? product.images : [];
  return images
    .filter((img) => Array.isArray(img?.cnnFeatures) && img.cnnFeatures.length > 0)
    .map((img) => ({ url: img.url, features: img.cnnFeatures }));
};

/**
 * Build a visual product fingerprint from the CNN features produced by
 * the existing ML pipeline.
 *
 * The aggregate fingerprint is the unit-normalized mean of the per-image
 * feature vectors. Returns { available: false, reason } — never a fraud
 * signal — when CNN features are unavailable for every image.
 *
 * @param {Object} product  Product document (or plain object)
 * @returns {Object} { available, reason?, fingerprint?, imageFeatures? }
 */
const buildProductFingerprint = (product) => {
  const imageFeatures = validImageFeatures(product);

  if (imageFeatures.length === 0) {
    return { available: false, reason: 'cnn_features_unavailable' };
  }

  const dims = imageFeatures[0].features.length;
  const sum = new Array(dims).fill(0);
  for (const { features } of imageFeatures) {
    if (features.length !== dims) continue;
    for (let i = 0; i < dims; i++) sum[i] += Number(features[i]) || 0;
  }

  let norm = 0;
  for (let i = 0; i < dims; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);

  const fingerprint = norm > 0 ? sum.map((v) => v / norm) : [];

  return {
    available: fingerprint.length > 0,
    ...(fingerprint.length > 0
      ? { fingerprint, imageFeatures }
      : { reason: 'cnn_features_unavailable' }),
  };
};

/**
 * Crosswise comparison of two product fingerprints (multi-image /
 * different-angle comparison).
 *
 * For each image in A, finds the strongest valid similarity across ALL
 * images in B — identical camera angles are not required. An aggregate
 * score is calculated from the valid best matches.
 *
 * @param {Object} fingerprintA result of buildProductFingerprint (listing A)
 * @param {Object} fingerprintB result of buildProductFingerprint (listing B)
 * @returns {Object} { available, reason?, bestMatches, aggregateSimilarity, similarity }
 *   - bestMatches: strongest match for each image of A
 *   - aggregateSimilarity: mean of the valid best matches
 *   - similarity: the strongest valid single-pair similarity
 */
const compareProductFingerprints = (fingerprintA, fingerprintB) => {
  if (!fingerprintA?.available || !fingerprintB?.available) {
    return {
      available: false,
      reason: fingerprintA?.reason || fingerprintB?.reason || 'cnn_features_unavailable',
      bestMatches: [],
      aggregateSimilarity: null,
      similarity: null,
    };
  }

  const bestMatches = [];
  let similarity = null;

  for (const imgA of fingerprintA.imageFeatures) {
    let best = null;
    for (const imgB of fingerprintB.imageFeatures) {
      const score = cosineSimilarity(imgA.features, imgB.features);
      if (score === null) continue;
      if (!best || score > best.similarity) {
        best = { aUrl: imgA.url, bUrl: imgB.url, similarity: score };
      }
    }
    if (best) {
      bestMatches.push(best);
      if (similarity === null || best.similarity > similarity) {
        similarity = best.similarity;
      }
    }
  }

  const aggregateSimilarity =
    bestMatches.length > 0
      ? bestMatches.reduce((s, m) => s + m.similarity, 0) / bestMatches.length
      : null;

  return { available: bestMatches.length > 0, bestMatches, aggregateSimilarity, similarity };
};

module.exports = {
  MEDIUM_SIMILARITY_THRESHOLD,
  STRONG_SIMILARITY_THRESHOLD,
  MAX_CANDIDATES,
  cosineSimilarity,
  buildProductFingerprint,
  compareProductFingerprints,
  validImageFeatures,
};
