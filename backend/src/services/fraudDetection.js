/**
 * Fraud / Risk Detection Service
 *
 * Detects suspicious signals:
 *  - Duplicate images across listings (perceptual hash similarity)
 *  - Suspicious pricing (way below market)
 *  - Repeated descriptions
 *  - Complaint history
 *  - New accounts with high value listings
 *  - Seller trust signals
 *  - Product identity / provenance (serial/IMEI/VIN ownership mismatch,
 *    reused identifiers, multiple active listings, stolen products)
 */

const Product = require('../models/Product');
const User = require('../models/User');
const Report = require('../models/Report');
const { hammingDistance } = require('./imageHash');
const {
  buildProductFingerprint,
  compareProductFingerprints,
  MEDIUM_SIMILARITY_THRESHOLD,
  STRONG_SIMILARITY_THRESHOLD,
  MAX_CANDIDATES,
} = require('./productFingerprint');

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

// Maximum hamming distance to consider two 64-bit perceptual hashes as "similar".
// Threshold of 12 validated against real photographs: catches all crop/recompress
// variants (max observed distance = 12) while producing zero false positives on
// same-category different products (min observed distance = 30, margin = 18 points).
// Single source of truth: read from HASH_SIMILARITY_THRESHOLD env var
// (defaulted in config/validateEnv.js) — the upload/edit gate threshold
// (constants.js DUPLICATE_HASH_THRESHOLD) consumes the same env var.
const HASH_SIMILARITY_THRESHOLD =
  Number(process.env.HASH_SIMILARITY_THRESHOLD) || 12;

// Product-identity fraud signals (from identityVerification.js), combined
// with the existing risk score below.
// Note: same identifier ≠ fraud. Same identifier + legitimate ownership
// transfer = normal resale (no mismatch signals emitted). Same identifier +
// conflicting ownership / no transfer = suspicious.
const IDENTITY_SIGNAL_WEIGHTS = {
  PRODUCT_IDENTIFIER_REUSED: { weight: 10, factor: 'Product identifier (serial/IMEI) reused from another listing' },
  MULTIPLE_ACTIVE_LISTINGS: { weight: 30, factor: 'Same physical product identifier on multiple active listings' },
  OWNERSHIP_MISMATCH: { weight: 35, factor: 'Identifier registered to a different owner with no verified ownership transfer' },
  NO_VERIFIED_TRANSFER: { weight: 15, factor: 'No verified ownership transfer found for this identifier' },
  PROVENANCE_INTEGRITY_FAILURE: { weight: 45, factor: 'Provenance chain integrity failure or flagged identity' },
  REPORTED_STOLEN_PRODUCT: { weight: 100, factor: 'Product identifier reported as stolen' },
  // Supporting signal only — a FAILED attempt is suspicious; UNVERIFIED
  // (never submitted) is deliberately absent: missing verification is
  // never treated as fraud on its own.
  POSSESSION_VERIFICATION_FAILED: { weight: 10, factor: 'Proof-of-possession verification failed (incorrect verification code)' },
};

// Visual product fingerprint (SCRUM-25): supporting signal ONLY. Similar
// appearance or the same model is never fraud on its own — two sellers may
// legitimately own the same model. High visual similarity is combined with
// other evidence by the existing signal weights below: only when VERY
// strong visual similarity coincides with conflicting evidence (ownership
// mismatch, multiple active listings, ...) can total risk become high.
// A visual match alone can never reach high risk or auto-flag a seller.
const VISUAL_PRODUCT_SIMILARITY_SIGNAL = 'VISUAL_PRODUCT_SIMILARITY';

// Weight tiers: MEDIUM threshold -> supporting signal (low weight);
// STRONG threshold -> slightly higher weight, still supporting only.
const visualSignalWeight = (similarity) => {
  if (typeof similarity === 'number' && similarity >= STRONG_SIMILARITY_THRESHOLD) {
    return { weight: 20, factor: 'Very strong visual product similarity to another listing — supporting evidence, combined with other risk factors' };
  }
  return { weight: 10, factor: 'Visual product similarity to another listing — supporting evidence only (same model is not fraud)' };
};

const detectRisk = async ({ product, hashes = [], aiAnalysis = {}, identitySignals = [], visualSignals = [], sameOwnerRelist = false }) => {
  const factors = [];
  let riskScore = 0;

  const sellerIsSame = (a, b) => {
    if (!a || !b) return false;
    return a.toString() === b.toString();
  };

  // 1. Duplicate image risk — similarity-based via perceptual hashing
  if (hashes && hashes.length > 0 && !sameOwnerRelist) {
    // Fetch candidate products in the same category (or all if no category)
    const candidateFilter = {
      _id: { $ne: product._id },
      status: { $in: ['active', 'sold'] },
    };
    if (product.category) {
      candidateFilter.category = product.category;
    }

    // Limit to recent 500 candidates to keep memory usage bounded
    const candidates = await Product.find(candidateFilter)
      .select('title aiAnalysis.imageHashes')
      .limit(500);

    for (const hash of hashes) {
      let duplicateFound = false;
      for (const candidate of candidates) {
        if (
          sameOwnerRelist &&
          sellerIsSame(product.seller?._id || product.seller, candidate.seller)
        ) {
          continue;
        }

        const candidateHashes = candidate.aiAnalysis?.imageHashes || [];
        for (const candidateHash of candidateHashes) {
          const distance = hammingDistance(hash, candidateHash);
          // null = non-pHash entry (e.g. sha256 fallback) — skip, never compare.
          if (distance !== null && distance <= HASH_SIMILARITY_THRESHOLD) {
            riskScore += 35;
            const similarityPct = Math.round((1 - distance / 64) * 100);
            factors.push(
              `Duplicate image detected (~${similarityPct}% similar to listing "${candidate.title}", distance: ${distance})`
            );
            duplicateFound = true;
            break;
          }
        }
        if (duplicateFound) break;
      }
      if (duplicateFound) break;
    }
  }

  // 2. Suspicious pricing
  const sellerAccountAgeDays = product.seller?.createdAt
    ? Math.floor((Date.now() - new Date(product.seller.createdAt)) / (1000 * 60 * 60 * 24))
    : 0;

  if (product.originalPrice > 0 && product.price > 0) {
    const priceRatio = product.price / product.originalPrice;
    if (priceRatio < 0.15) {
      riskScore += 25;
      factors.push('Price is suspiciously low (<15% of original price)');
    } else if (priceRatio > 1.5) {
      riskScore += 10;
      factors.push('Price is significantly above original price');
    }
  }

  if (product.price > 5000 && sellerAccountAgeDays < 30) {
    riskScore += 15;
    factors.push('High-value listing from new account');
  }

  // 3. Repeated content (same description in multiple active listings)
  // A sold-then-relisted product is a legitimate reuse of the same owner/
  // listing identity, not a duplicate-description fraud pattern. Only count
  // active listings for this supporting signal so same-owner relists stay low risk.
  if (product.description && !sameOwnerRelist) {
    const dupCount = await Product.countDocuments({
      _id: { $ne: product._id },
      status: 'active',
      seller: product.seller?._id || product.seller,
      description: product.description,
    });
    if (dupCount >= 2) {
      riskScore += 20;
      factors.push(`Same description used in ${dupCount + 1} active listings`);
    }
  }

  // 4. Seller complaint history
  if (product.seller) {
    const sellerId = product.seller._id || product.seller;
    const userReports = await Report.countDocuments({
      target: sellerId,
      targetType: 'user',
      status: { $in: ['pending', 'reviewing', 'resolved'] },
    });
    if (userReports > 3) {
      riskScore += 15;
      factors.push(`Seller has ${userReports} reports against them`);
    }
  }

  // 5. Risk from AI analysis
  // Aligned with computerVision.detectDamage's 'high' band (>= 50). Previously
  // 60, which the heuristic could never reach (max was 50 from overlapping
  // quality rules), so this supporting signal was dead code.
  if (aiAnalysis.damageScore >= 50) {
    riskScore += 5;
    factors.push('High damage score detected by AI');
  }

  // 6. Product identity / provenance signals (extension — combined with
  //    existing image/pricing/trust signals)
  const seenSignals = new Set();
  for (const signal of identitySignals) {
    const config = IDENTITY_SIGNAL_WEIGHTS[signal];
    if (!config || seenSignals.has(signal)) continue;
    seenSignals.add(signal);
    riskScore += config.weight;
    factors.push(config.factor);
  }

  // 7. Visual product fingerprint similarity (SCRUM-25 supporting signal).
  //    Entries may be plain signal names or { signal, similarity } objects
  //    carrying the measured cosine similarity. Thresholds are configurable
  //    (productFingerprint.js); a visual match alone never reaches high risk.
  for (const entry of visualSignals) {
    const signal = typeof entry === 'string' ? entry : entry?.signal;
    if (signal !== VISUAL_PRODUCT_SIMILARITY_SIGNAL || seenSignals.has(signal)) continue;
    seenSignals.add(signal);
    const { weight, factor } = visualSignalWeight(
      typeof entry === 'object' ? entry.similarity : undefined
    );
    riskScore += weight;
    factors.push(factor);
  }

  riskScore = clamp(riskScore, 0, 100);

  // v1 AUTHORITATIVE risk bands (backend, 0-100 additive scale):
  //   high   >= 50 | medium >= 25 | low < 25
  // v2 mapping (ml-service, calibrated probability 0-1):
  //   flag/review thresholds come from models_saved/fraud_v2_thresholds.json
  //   (currently 0.95 flag / 0.475 review; env defaults FRAUD_HIGH_THRESHOLD
  //   0.60 / FRAUD_MEDIUM_THRESHOLD 0.30 apply only when the file is missing).
  // v2 runs in SHADOW mode only (ML_PIPELINE_V2=shadow: legacy served, both
  // logged) — its output never sets listing status. The additive score and
  // these bands remain the single source of truth.
  let riskLevel = 'low';
  if (riskScore >= 50) riskLevel = 'high';
  else if (riskScore >= 25) riskLevel = 'medium';

  return {
    riskScore,
    riskLevel,
    factors,
  };
};

/**
 * Visual product fingerprint assessment (SCRUM-25). Compares a listing's
 * CNN fingerprint crosswise against other active/sold listings with CNN
 * features (same category when available).
 *
 * Conservative, configurable thresholds (productFingerprint.js):
 *   - below MEDIUM threshold:  no visual signal
 *   - MEDIUM..STRONG:          supporting VISUAL_PRODUCT_SIMILARITY signal
 *   - >= STRONG:               same signal at a slightly higher weight —
 *                              still supporting only, never blocking
 *
 * CNN unavailability returns { available: false } and is never fraud.
 * Best-effort: callers (the image worker) treat failures as warnings.
 *
 * @param {Object} params
 * @param {string} params.productId        Listing to assess
 * @param {string} [params.excludeProductId] Extra listing to exclude
 * @returns {Object} { available, reason?, signal?, similarity?, similarTo? }
 */
const assessVisualSimilarity = async ({ productId, excludeProductId }) => {
  const product = await Product.findById(productId)
    .select('title category images.cnnFeatures')
    .lean();
  if (!product) {
    return { available: false, reason: 'product_not_found' };
  }

  const fingerprint = buildProductFingerprint(product);
  if (!fingerprint.available) {
    return { available: false, reason: fingerprint.reason };
  }

  const candidateFilter = {
    status: { $in: ['active', 'sold'] },
  };
  candidateFilter._id = { $nin: [product._id, ...(excludeProductId ? [excludeProductId] : [])] };
  if (product.category) {
    candidateFilter.category = product.category;
  }

  const candidates = await Product.find(candidateFilter)
    .select('title category images.cnnFeatures')
    .limit(MAX_CANDIDATES)
    .lean();

  let best = null;
  for (const candidate of candidates) {
    const candidateFingerprint = buildProductFingerprint(candidate);
    const comparison = compareProductFingerprints(fingerprint, candidateFingerprint);
    if (!comparison.available) continue;
    if (!best || comparison.similarity > best.similarity) {
      best = {
        similarity: comparison.similarity,
        aggregateSimilarity: comparison.aggregateSimilarity,
        similarTo: candidate._id.toString(),
        similarToTitle: candidate.title,
      };
    }
  }

  if (!best || best.similarity < MEDIUM_SIMILARITY_THRESHOLD) {
    return { available: true, signal: null, similarity: best?.similarity ?? null };
  }

  const { weight, factor } = visualSignalWeight(best.similarity);
  return {
    available: true,
    signal: VISUAL_PRODUCT_SIMILARITY_SIGNAL,
    similarity: best.similarity,
    similarTo: best.similarTo,
    weight,
    factor,
  };
};

module.exports = {
  detectRisk,
  assessVisualSimilarity,
  VISUAL_PRODUCT_SIMILARITY_SIGNAL,
  VISUAL_SIGNAL_WEIGHTS: IDENTITY_SIGNAL_WEIGHTS,
};
