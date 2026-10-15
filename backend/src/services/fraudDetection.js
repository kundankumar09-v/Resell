/**
 * Fraud / Risk Detection Service
 *
 * Detects suspicious signals:
 *  - Duplicate images across listings (perceptual hash similarity)
 *  - Suspicious pricing (way below market)
 *  - Repeated descriptions — exact match (fast path) AND near-duplicate
 *    similarity (character n-grams / CLIP text embeddings) so a 2-word edit
 *    does not evade the check
 *  - Scam-text patterns (off-platform contact, urgency clichés, formatting
 *    abuse, urgency+lowball interaction) — see textScamAnalyzer.js
 *  - Complaint history
 *  - New accounts with high value listings
 *  - Seller trust signals
 *  - Product identity / provenance (serial/IMEI/VIN ownership mismatch,
 *    reused identifiers, multiple active listings, stolen products)
 *
 * Also exposes `fuseFraudScores()` — the documented v1/v2 combination policy
 * used by the image worker where both engines' outputs are available.
 */

const Product = require('../models/Product');
const User = require('../models/User');
const Report = require('../models/Report');
const { hammingDistance } = require('./imageHash');
const { analyzeTextScam } = require('./textScamAnalyzer');
const { charNgramJaccard, cosineSimilarity, normalizeText } = require('./textSimilarity');
const mlClient = require('./mlClient');
const { searchVectorNearestNeighbors } = require('./vectorSearch');
const {
  buildProductFingerprint,
  compareProductFingerprints,
  MEDIUM_SIMILARITY_THRESHOLD,
  STRONG_SIMILARITY_THRESHOLD,
  MAX_CANDIDATES,
} = require('./productFingerprint');

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

// Candidate-pool caps: how many other listings each bounded scan compares
// against. The duplicate-image (pHash) scan defaults to 500; the CNN/visual
// similarity scan is sized by VISUAL_SCAN_CAP (productFingerprint.js
// MAX_CANDIDATES). Raised caps cost memory/time; lowered caps risk coverage
// gaps, which truncation logging below surfaces explicitly.
const envNum = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const DUPLICATE_SCAN_CAP = envNum('DUPLICATE_SCAN_CAP', 500);

// Near-duplicate description scan (README §7.9). Same-seller listings are the
// strongest signal so they are capped tightly (DESC_DUP_SCAN_CAP, default 100).
// The optional cross-seller sweep stays inside the listing's category and is
// capped separately (200). Similarity is CLIP text embeddings (0.92) when the
// ML service is reachable, otherwise character 3-gram Jaccard (0.85).
const DESC_DUP_SCAN_CAP = envNum('DESC_DUP_SCAN_CAP', 100);
const OTHER_SELLER_DESC_SCAN_CAP = envNum('OTHER_SELLER_DESC_SCAN_CAP', 200);
const TEXT_SIMILARITY_ML_THRESHOLD = 0.92;
const TEXT_SIMILARITY_NGRAM_THRESHOLD = 0.85;
const CROSS_LISTING_TEXT_DUPLICATE_SAME_SELLER_WEIGHT = 20; // matches exact-match weight
const CROSS_LISTING_TEXT_DUPLICATE_OTHER_SELLER_WEIGHT = 15;

// Generalize the analyzer's detailed factor strings to a category. Text-scam
// factors are additionally surfaced via 'content_scam_signals' (added
// explicitly in detectRisk) so non-admin surfaces can react to them without
// seeing the raw thresholds.
const CONTENT_SCAM_CATEGORY = 'content_scam_signals';

// ── Image–text mismatch (content mismatch) ──────────────────────────────────
// A listing titled "iPhone 15 Pro" showing shoes or a screenshot passes every
// pHash and description check. This compares the listing's CLIP *image*
// embedding with the CLIP *text* embedding of its title (POST /text-embed).
// Supporting-only, mirroring the CNN-fingerprint philosophy: only the STRONG
// mismatch band fires, short or purely generic titles are skipped, and a
// missing ML service (no embedding) skips silently.
const IMAGE_TEXT_MISMATCH_WEIGHT = 15;
const IMAGE_TEXT_MISMATCH_SIMILARITY_THRESHOLD = envNum('IMAGE_TEXT_MISMATCH_THRESHOLD', 0.2);
const IMAGE_TEXT_WEAK_MATCH_SIMILARITY_THRESHOLD = envNum('IMAGE_TEXT_WEAK_MATCH_SIMILARITY_THRESHOLD', 0.3);
const IMAGE_TEXT_MIN_TITLE_WORDS = envNum('IMAGE_TEXT_MIN_TITLE_WORDS', 3);
const IMAGE_TEXT_MISMATCH_SIGNAL = 'IMAGE_TEXT_MISMATCH';
const IMAGE_TEXT_MISMATCH_FACTOR =
  'Listing image does not match its title (image-text similarity in the strong-mismatch band) — supporting evidence';
const CONTENT_MISMATCH_CATEGORY = 'content_mismatch';

// Titles made up entirely of these non-specific tokens ("phone", "laptop for
// sale") say nothing about the item, so an image/text disagreement carries no
// evidence and must never fire.
const GENERIC_TITLE_TERMS = new Set([
  'phone', 'phones', 'laptop', 'laptops', 'computer', 'computers', 'tablet', 'tablets',
  'device', 'devices', 'gadget', 'gadgets', 'item', 'items', 'thing', 'things', 'stuff',
  'sale', 'sell', 'selling', 'sold', 'for', 'and', 'the', 'a', 'an', 'with', 'used',
  'new', 'brand', 'good', 'great', 'nice', 'cheap', 'quality', 'best', 'offer', 'deal',
  'original', 'genuine', 'perfect', 'working', 'condition', 'fast', 'free',
]);

// ── Category agreement (content mismatch) ───────────────────────────────────
// MobileNet predicts a category from the photo; if it confidently disagrees
// with the category the seller chose, the listing may be miscategorised to
// dodge the same-category pHash/visual gates. Supporting-only: fires only at
// confidence >= CATEGORY_MISMATCH_MIN_CONFIDENCE (0.5). When it fires the
// worker also widens the pHash candidate pool to the suggested category.
const CATEGORY_MISMATCH_WEIGHT = 10;
const CATEGORY_MISMATCH_MIN_CONFIDENCE = envNum('CATEGORY_MISMATCH_MIN_CONFIDENCE', 0.5);
const CATEGORY_MISMATCH_SIGNAL = 'CATEGORY_MISMATCH';
const CATEGORY_MISMATCH_FACTOR =
  'Listing category disagrees with the category detected in the image (AI classification) — supporting evidence';

// ── Cross-category CLIP image repost ────────────────────────────────────────
// Platform-wide, cross-seller CLIP vector scan (vectorSearch.js) that catches
// the same photo re-posted under a DIFFERENT category, where the
// category-scoped pHash gate cannot see it. Supporting-only and explicitly
// subordinate to the pHash duplicate signal: it is suppressed whenever pHash
// already fired, so it can never push a listing above the pHash duplicate
// weight. Skipped silently when the ML service is down (no embedding).
const CROSS_CATEGORY_SIM_THRESHOLD = envNum('CROSS_CATEGORY_SIM_THRESHOLD', 0.93);
const CROSS_CATEGORY_SCAN_K = envNum('CROSS_CATEGORY_SCAN_K', 50);
const CROSS_CATEGORY_IMAGE_REPOST_WEIGHT = 20;
const CROSS_CATEGORY_IMAGE_REPOST_SIGNAL = 'CROSS_CATEGORY_IMAGE_REPOST';
const CROSS_CATEGORY_IMAGE_REPOST_FACTOR =
  "CROSS_CATEGORY_IMAGE_REPOST: platform-wide image match to another seller's listing in another category — supporting evidence";

// ── Listing velocity (behavioral) ───────────────────────────────────────────
// A seller publishing many listings in a short window is a classic
// mass-spam / account-takeover pattern. Counted with a single indexed query
// over the seller's listings in the last LISTING_VELOCITY_WINDOW_HOURS (24).
// Behavioral and capped: the two thresholds never stack — the larger (+15)
// wins when both would apply.
const LISTING_VELOCITY_WINDOW_HOURS = envNum('LISTING_VELOCITY_WINDOW_HOURS', 24);
const LISTING_BURST_NEW_ACCOUNT_MIN = envNum('LISTING_BURST_NEW_ACCOUNT_MIN', 5);
const LISTING_BURST_MIN = envNum('LISTING_BURST_MIN', 10);
const LISTING_BURST_NEW_ACCOUNT_MAX_AGE_DAYS = envNum('LISTING_BURST_NEW_ACCOUNT_MAX_AGE_DAYS', 7);
const LISTING_BURST_NEW_ACCOUNT_WEIGHT = 15;
const LISTING_BURST_WEIGHT = 10;
const LISTING_BURST_NEW_ACCOUNT_SIGNAL = 'LISTING_BURST_NEW_ACCOUNT';
const LISTING_BURST_SIGNAL = 'LISTING_BURST';
const LISTING_BURST_NEW_ACCOUNT_FACTOR = `Listing burst: ${LISTING_BURST_NEW_ACCOUNT_MIN}+ listings in ${LISTING_VELOCITY_WINDOW_HOURS}h from a new account`;
const LISTING_BURST_FACTOR = `Listing burst: ${LISTING_BURST_MIN}+ listings in ${LISTING_VELOCITY_WINDOW_HOURS}h`;

// Generalized risk categories exposed to non-admin surfaces. The detailed
// factor strings expose internal thresholds (e.g. "<15% of original price");
// buyers/sellers only see these coarse categories, while admins see the full
// factors. Kept exhaustive via the 'other' fallback.
const RISK_FACTOR_CATEGORIES = [
  'possible_duplicate_image',
  'pricing_anomaly',
  'account_risk',
  'identity_concern',
  'content_scam_signals',
  'content_mismatch',
  'content_quality',
  'other',
];

const mapFactorToCategory = (factor) => {
  const f = String(factor || '');
  if (/duplicate image|visual product similarity|cross_category_image_repost/i.test(f)) {
    return 'possible_duplicate_image';
  }
  if (/image-text mismatch|does not match its title|category mismatch|category disagreement|category disagrees/i.test(f)) {
    return CONTENT_MISMATCH_CATEGORY;
  }
  if (/contact information in listing|urgency\/pressure language|excessive capitali|excessive punctuation|lowball price combined/i.test(f)) {
    return 'content_scam_signals';
  }
  if (/price|suspiciously low|above original/i.test(f)) return 'pricing_anomaly';
  if (/new account|reports against|listing burst/i.test(f)) return 'account_risk';
  if (/identifier|ownership|possession|provenance|stolen/i.test(f)) return 'identity_concern';
  if (/description|damage|quality/i.test(f)) return 'content_quality';
  return 'other';
};

/**
 * Build the full 64-bit pHash set for a product's stored analysis: normal,
 * mirror, rotation (90/180/270) and vertical-flip entries. Guarantees every
 * duplicate check compares the complete hash set regardless of which fields
 * a document was written with (older rows have only imageHashes).
 */
const collectHashSet = (aiAnalysis = {}) => [
  ...new Set(
    [
      ...(Array.isArray(aiAnalysis?.imageHashes) ? aiAnalysis.imageHashes : []),
      ...(Array.isArray(aiAnalysis?.mirrorHashes) ? aiAnalysis.mirrorHashes : []),
      ...(Array.isArray(aiAnalysis?.rotationHashes) ? aiAnalysis.rotationHashes : []),
      ...(Array.isArray(aiAnalysis?.vflipHash) ? aiAnalysis.vflipHash : [aiAnalysis?.vflipHash]),
    ].filter(Boolean)
  ),
];

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

// ── Near-duplicate description detection (README §7.9) ──────────────────────
// The exact-match check below only catches byte-identical descriptions; a
// scammer editing 2 words evades it. This adds a similarity-based second pass.
//
// Honest labeling: the fallback (character 3-gram Jaccard) is a lexical
// overlap measure, and the preferred path (CLIP text embeddings from the ML
// service) is a frozen general-purpose encoder — neither is a fraud-specific
// model. Both are cheap ways to catch copy-paste-then-tweak.
const ML_TEXT_HEALTH_TTL_MS = envNum('DESC_DUP_ML_HEALTH_TTL_MS', 30000);
let mlTextHealthCache = { available: false, checkedAt: 0 };

/**
 * Is the ML service reachable for text embeddings? Cached for a short TTL so
 * detectRisk() does not probe the network on every call. Never throws.
 */
const isMlTextEmbeddingAvailable = async () => {
  const now = Date.now();
  if (now - mlTextHealthCache.checkedAt < ML_TEXT_HEALTH_TTL_MS) {
    return mlTextHealthCache.available;
  }
  let available = false;
  try {
    available = await mlClient.checkHealth();
  } catch {
    available = false;
  }
  mlTextHealthCache = { available, checkedAt: now };
  return available;
};

/**
 * Best similarity match between `description` and a list of candidate
 * documents. Uses CLIP text embeddings (cosine, threshold 0.92) when the ML
 * service is reachable, else character 3-gram Jaccard (threshold 0.85).
 *
 * @returns {null | { similarity, candidate, method, threshold }}
 */
const findBestTextMatch = async ({ description, candidates }) => {
  const target = normalizeText(description);
  if (!target || !Array.isArray(candidates) || candidates.length === 0) return null;

  const candidateTexts = candidates.map((c) => normalizeText(c.description));

  let method = 'char-3gram-jaccard';
  let threshold = TEXT_SIMILARITY_NGRAM_THRESHOLD;
  let similarities = null;

  if (await isMlTextEmbeddingAvailable()) {
    const targetEmbedding = await mlClient.getTextEmbedding(target);
    if (targetEmbedding) {
      const embeddings = [];
      let allOk = true;
      for (const text of candidateTexts) {
        const embedding = await mlClient.getTextEmbedding(text);
        if (!embedding) {
          allOk = false;
          break;
        }
        embeddings.push(embedding);
      }
      if (allOk && embeddings.length === candidateTexts.length) {
        similarities = embeddings.map((e) => cosineSimilarity(targetEmbedding, e));
        method = 'ml-text-embedding';
        threshold = TEXT_SIMILARITY_ML_THRESHOLD;
      }
    }
  }

  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    const similarity = similarities
      ? similarities[i]
      : charNgramJaccard(target, candidateTexts[i]);
    if (!Number.isFinite(similarity)) continue;
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { similarity, candidate: candidates[i] };
    }
  }
  return best ? { ...best, method, threshold } : null;
};

/**
 * Look for a near-duplicate description on the seller's own active listings
 * (cap DESC_DUP_SCAN_CAP) and, if none, optionally across other sellers in the
 * same category (cap OTHER_SELLER_DESC_SCAN_CAP).
 *
 * @returns {null | { similar: true, sameSeller, similarity, candidate, method }}
 */
const findDescriptionDuplicate = async (product) => {
  const description = normalizeText(product.description);
  if (!description) return null;
  const sellerId = product.seller?._id || product.seller;

  const sameSellerCandidates = await Product.find({
    _id: { $ne: product._id },
    status: 'active',
    seller: sellerId,
    description: { $nin: [null, ''] },
  })
    .select('title description')
    .limit(DESC_DUP_SCAN_CAP)
    .lean();

  const sameSeller = await findBestTextMatch({ description, candidates: sameSellerCandidates });
  if (sameSeller) return { ...sameSeller, sameSeller: true };

  if (!product.category) return null;

  const otherSellerCandidates = await Product.find({
    _id: { $ne: product._id },
    status: 'active',
    category: product.category,
    seller: { $ne: sellerId },
    description: { $nin: [null, ''] },
  })
    .select('title description')
    .limit(OTHER_SELLER_DESC_SCAN_CAP)
    .lean();

  const otherSeller = await findBestTextMatch({ description, candidates: otherSellerCandidates });
  if (otherSeller) return { ...otherSeller, sameSeller: false };

  return null;
};

/**
 * True when a title is too short or too generic for an image/text
 * disagreement to be meaningful evidence. Keeps the mismatch signal from
 * firing on listings that never named the product in the first place
 * ("phone", "laptop for sale").
 */
const isGenericOrShortTitle = (title) => {
  const tokens = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < IMAGE_TEXT_MIN_TITLE_WORDS) return true;
  return tokens.every((t) => GENERIC_TITLE_TERMS.has(t));
};

/**
 * Classify an image/title cosine similarity into a band.
 *   unavailable           -> no numeric similarity (ML down / no embedding)
 *   skipped_generic_title -> short/generic title, deliberately not evaluated
 *   strong_mismatch       -> < IMAGE_TEXT_MISMATCH_SIMILARITY_THRESHOLD (fires)
 *   weak_match            -> [0.20, 0.30): +0, logged for shadow analysis
 *   match                 -> >= 0.30
 */
const classifyImageTextMatch = ({ similarity, title } = {}) => {
  if (!Number.isFinite(similarity)) {
    return { band: 'unavailable', signal: null, similarity: null };
  }
  if (isGenericOrShortTitle(title)) {
    return { band: 'skipped_generic_title', signal: null, similarity };
  }
  if (similarity < IMAGE_TEXT_MISMATCH_SIMILARITY_THRESHOLD) {
    return { band: 'strong_mismatch', signal: IMAGE_TEXT_MISMATCH_SIGNAL, similarity };
  }
  if (similarity < IMAGE_TEXT_WEAK_MATCH_SIMILARITY_THRESHOLD) {
    return { band: 'weak_match', signal: null, similarity };
  }
  return { band: 'match', signal: null, similarity };
};

/**
 * Compute the CLIP image/text cosine similarity from two embeddings and
 * classify it. Returns band 'unavailable' (never throws) when either
 * embedding is missing — this is the ML-service-down path.
 */
const assessImageTextMismatch = ({ imageEmbedding, textEmbedding, title } = {}) => {
  const similarity = cosineSimilarity(imageEmbedding, textEmbedding);
  return classifyImageTextMatch({ similarity, title });
};

/**
 * Compare the worker's MobileNet-predicted category against the category the
 * seller chose. Returns { mismatch, reason }:
 *   category_unavailable -> no usable prediction (missing/"Other") or no chosen name
 *   low_confidence       -> prediction below CATEGORY_MISMATCH_MIN_CONFIDENCE
 *   agreement            -> same category (case-insensitive)
 *   mismatch             -> confident disagreement (fires CATEGORY_MISMATCH)
 */
const assessCategoryAgreement = ({ predictedCategory, confidence, chosenCategoryName } = {}) => {
  const predicted = String(predictedCategory || '').trim().toLowerCase();
  const chosen = String(chosenCategoryName || '').trim().toLowerCase();
  if (!predicted || predicted === 'other' || !chosen) {
    return { mismatch: false, reason: 'category_unavailable' };
  }
  if (!Number.isFinite(confidence) || confidence < CATEGORY_MISMATCH_MIN_CONFIDENCE) {
    return { mismatch: false, reason: 'low_confidence' };
  }
  if (predicted === chosen) return { mismatch: false, reason: 'agreement' };
  return { mismatch: true, reason: 'mismatch' };
};

/**
 * Resolve the seller account age in days. Prefers a populated
 * `product.seller.createdAt` (create/update paths) and otherwise does a single
 * indexed User lookup — the worker passes an unpopulated ObjectId, so
 * `product.seller.createdAt` is undefined there. Returns null when the user
 * cannot be resolved (never throws), so the caller can skip the age-gated band.
 */
const resolveSellerAccountAgeDays = async (product, sellerId) => {
  if (product?.seller?.createdAt) {
    return Math.floor((Date.now() - new Date(product.seller.createdAt)) / 86400000);
  }
  try {
    const user = await User.findById(sellerId).select('createdAt').lean();
    if (!user?.createdAt) return null;
    return Math.floor((Date.now() - new Date(user.createdAt)) / 86400000);
  } catch (err) {
    return null;
  }
};

/**
 * Platform-wide CLIP nearest-neighbour scan for a cross-seller image repost.
 * Requires a 512-D embedding (skips silently when the ML service is down or
 * the embedding is missing). Only cross-seller hits count; the best hit at or
 * above CROSS_CATEGORY_SIM_THRESHOLD raises CROSS_CATEGORY_IMAGE_REPOST.
 * detectRisk suppresses it when the pHash duplicate gate already fired.
 */
const assessCrossCategoryImageRepost = async ({ productId, embedding, sellerId } = {}) => {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return { available: false, signal: null, reason: 'embedding_unavailable' };
  }

  let neighbours = [];
  try {
    neighbours = await searchVectorNearestNeighbors(embedding, {
      limit: CROSS_CATEGORY_SCAN_K,
      status: 'active',
      excludeId: productId || null,
      crossCategory: true,
    });
  } catch (err) {
    return { available: false, signal: null, reason: 'vector_search_unavailable' };
  }

  const seller = sellerId ? sellerId.toString() : null;
  let best = null;
  for (const candidate of neighbours || []) {
    const candidateSeller =
      candidate?.seller?._id?.toString?.() || candidate?.seller?.toString?.() || null;
    if (seller && candidateSeller && candidateSeller === seller) continue;
    if (!Number.isFinite(candidate?.score)) continue;
    if (!best || candidate.score > best.score) best = candidate;
  }

  if (!best || best.score < CROSS_CATEGORY_SIM_THRESHOLD) {
    return { available: true, signal: null, similarity: best ? best.score : null };
  }

  return {
    available: true,
    signal: CROSS_CATEGORY_IMAGE_REPOST_SIGNAL,
    similarity: best.score,
    similarTo: best._id,
    similarToTitle: best.title,
  };
};

const detectRisk = async ({
  product,
  hashes = [],
  aiAnalysis = {},
  identitySignals = [],
  visualSignals = [],
  sameOwnerRelist = false,
  imageTextSimilarity = null,
  categoryMismatch = false,
  additionalScanCategories = [],
  crossCategoryRepost = null,
}) => {
  const factors = [];
  let riskScore = 0;

  const sellerIsSame = (a, b) => {
    if (!a || !b) return false;
    return a.toString() === b.toString();
  };

  // 1. Duplicate image risk — similarity-based via perceptual hashing
  //    Compare the FULL hash set (normal + mirror + rotation + vertical-flip)
  //    on both sides: an upload rotated 90° can only match the original when
  //    the original's stored rotation hashes are compared as well.
  //    Fallback to the legacy `hashes` arg when aiAnalysis carries no hashes
  //    (callers that pass bare aiAnalysis keep the old probe set).
  const collectedHashes = collectHashSet(aiAnalysis);
  const probeHashes = collectedHashes.length > 0 ? collectedHashes : hashes;
  // Tracks whether the pHash duplicate gate fired — used to suppress the
  // subordinate cross-category CLIP repost signal so it can never push a
  // listing above the pHash duplicate weight.
  let phashDuplicateFound = false;
  if (probeHashes.length > 0 && !sameOwnerRelist) {
    const candidateFilter = {
      _id: { $ne: product._id },
      status: { $in: ['active', 'sold'] },
    };
    // Category-scoped by default; when the worker detects a confident category
    // mismatch it passes the suggested category here so the probe scans BOTH
    // categories instead of letting a miscategorised repost dodge the gate.
    const scanCategoryIds = [];
    const seenCategoryIds = new Set();
    for (const c of [
      product.category,
      ...(Array.isArray(additionalScanCategories) ? additionalScanCategories : []),
    ]) {
      if (!c) continue;
      const key = c.toString();
      if (seenCategoryIds.has(key)) continue;
      seenCategoryIds.add(key);
      scanCategoryIds.push(c);
    }
    if (scanCategoryIds.length === 1) {
      candidateFilter.category = scanCategoryIds[0];
    } else if (scanCategoryIds.length > 1) {
      candidateFilter.category = { $in: scanCategoryIds };
    }

    // Bound the candidate pool and surface truncation so coverage gaps at
    // scale are visible instead of silent under-scanning.
    // TODO(scalability): replace both bounded brute-force candidate scans
    // (here and in assessVisualSimilarity below) with the ml-service HNSW
    // ANN index (ml-service/pipeline/ann_index.py) once per-listing
    // embeddings exist.
    const [candidateTotal, candidates] = await Promise.all([
      Product.countDocuments(candidateFilter),
      Product.find(candidateFilter)
        .select('title aiAnalysis.imageHashes aiAnalysis.rotationHashes aiAnalysis.vflipHash')
        .limit(DUPLICATE_SCAN_CAP),
    ]);
    if (candidateTotal > DUPLICATE_SCAN_CAP) {
      console.warn(
        `[fraud] candidate pool truncated: ${candidateTotal} candidates, cap ${DUPLICATE_SCAN_CAP} — coverage incomplete for category ${product.category || 'all'}`
      );
    }

    for (const hash of probeHashes) {
      let duplicateFound = false;
      for (const candidate of candidates) {
        if (
          sameOwnerRelist &&
          sellerIsSame(product.seller?._id || product.seller, candidate.seller)
        ) {
          continue;
        }

        const candidateHashes = collectHashSet(candidate.aiAnalysis);
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
            phashDuplicateFound = true;
            break;
          }
        }
        if (duplicateFound) break;
      }
      if (duplicateFound) break;
    }
  }

  // 2. Suspicious pricing — continuous graduated scale instead of a single
  //    binary threshold. The low-price penalty ramps linearly from 0 at 15% of
  //    original MSRP up to 25 at 0%; the above-original penalty ramps 0..10.
  //    Ceil is used so a listing just under the threshold still earns points
  //    (e.g. 14.9% -> 1pt), keeping the signal continuous at the boundary.
  const sellerAccountAgeDays = product.seller?.createdAt
    ? Math.floor((Date.now() - new Date(product.seller.createdAt)) / (1000 * 60 * 60 * 24))
    : 0;

  if (product.originalPrice > 0 && product.price > 0) {
    const priceRatio = product.price / product.originalPrice;
    const lowPricePoints = clamp(Math.ceil((0.15 - priceRatio) * 250), 0, 25);
    if (lowPricePoints > 0) {
      riskScore += lowPricePoints;
      factors.push('Price is suspiciously low (<15% of original price)');
    } else {
      const highPricePoints = clamp(
        Math.min(10, Math.ceil((priceRatio - 1.5) * 20)),
        0,
        10
      );
      if (highPricePoints > 0) {
        riskScore += highPricePoints;
        factors.push('Price is significantly above original price');
      }
    }
  }

  if (product.price > 5000 && sellerAccountAgeDays < 30) {
    riskScore += 15;
    factors.push('High-value listing from new account');
  }

  // 3. Repeated content — exact match fast path, then near-duplicate similarity.
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
    if (dupCount >= 1) {
      // Fast path — identical description. No similarity scan needed.
      riskScore += 20;
      factors.push(`Same description used in ${dupCount + 1} active listings`);
    } else {
      // Similarity path — catches the "same listing, 2 words changed" evasion.
      const textDup = await findDescriptionDuplicate(product);
      if (textDup) {
        riskScore += textDup.sameSeller
          ? CROSS_LISTING_TEXT_DUPLICATE_SAME_SELLER_WEIGHT
          : CROSS_LISTING_TEXT_DUPLICATE_OTHER_SELLER_WEIGHT;
        const pct = Math.round(textDup.similarity * 100);
        factors.push(
          `CROSS_LISTING_TEXT_DUPLICATE: near-duplicate description (~${pct}% similar via ${
            textDup.method
          }) to ${textDup.sameSeller ? 'another' : "another seller's"} active listing "${textDup.candidate.title}"`
        );
      }
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

  // 8. Scam-text pattern signals (keyword/regex heuristics, capped at +25).
  //    Lexical only — see textScamAnalyzer.js for the honesty note. The
  //    urgency+lowball interaction is deliberately here rather than in the
  //    linear price block because neither half is meaningful alone.
  const textScam = analyzeTextScam({
    title: product.title,
    description: product.description,
    price: product.price,
    originalPrice: product.originalPrice,
  });
  if (textScam.score > 0) {
    riskScore += textScam.score;
    factors.push(...textScam.factors);
  }

  // 9. Image–text mismatch (supporting-only). A listing can be titled
  //    "iPhone 15 Pro" while showing unrelated photos and pass both the pHash
  //    and description checks. The worker computes the CLIP image↔title cosine
  //    similarity and passes it here; only the STRONG mismatch band fires, and
  //    short or generic titles are skipped (classifyImageTextMatch). Skipped
  //    silently when the ML service is down (similarity is not a number).
  const imageText = classifyImageTextMatch({
    similarity: imageTextSimilarity ?? aiAnalysis.imageTextSimilarity,
    title: product.title,
  });
  if (imageText.band === 'weak_match') {
    // Shadow analysis only — no risk points. Logged so the thresholds can be
    // re-tuned against real traffic before the band is ever enforced.
    console.log(
      `[fraud] image-text weak match (shadow, +0): ${imageText.similarity.toFixed(3)} — "${product.title}"`
    );
  }
  if (imageText.signal === IMAGE_TEXT_MISMATCH_SIGNAL) {
    riskScore += IMAGE_TEXT_MISMATCH_WEIGHT;
    factors.push(IMAGE_TEXT_MISMATCH_FACTOR);
  }

  // 10. Category disagreement (supporting-only). The worker compares the
  //     MobileNet-predicted category to the seller's chosen category and only
  //     passes a confident disagreement (>= 0.5) through here.
  if (categoryMismatch) {
    riskScore += CATEGORY_MISMATCH_WEIGHT;
    factors.push(CATEGORY_MISMATCH_FACTOR);
  }

  // 11. Cross-category CLIP image repost (supporting-only, subordinate to
  //     pHash — never exceeds the +35 duplicate weight).
  if (
    crossCategoryRepost &&
    crossCategoryRepost.signal === CROSS_CATEGORY_IMAGE_REPOST_SIGNAL &&
    !phashDuplicateFound
  ) {
    riskScore += CROSS_CATEGORY_IMAGE_REPOST_WEIGHT;
    if (crossCategoryRepost.similarToTitle) {
      const pct = Math.round((crossCategoryRepost.similarity || 0) * 100);
      factors.push(
        `CROSS_CATEGORY_IMAGE_REPOST: platform-wide image match (~${pct}%) to another seller's listing "${crossCategoryRepost.similarToTitle}" in a different category — supporting evidence`
      );
    } else {
      factors.push(CROSS_CATEGORY_IMAGE_REPOST_FACTOR);
    }
  }

  // 12. Listing velocity (behavioral). Single indexed count over the seller's
  //     other listings in the last LISTING_VELOCITY_WINDOW_HOURS (24). The two
  //     thresholds never stack — the larger (+15) wins when both would apply.
  if (product.seller) {
    const sellerId = product.seller._id || product.seller;
    const windowStart = new Date(
      Date.now() - LISTING_VELOCITY_WINDOW_HOURS * 60 * 60 * 1000
    );
    const recentListingCount = await Product.countDocuments({
      _id: { $ne: product._id },
      seller: sellerId,
      createdAt: { $gte: windowStart },
      status: { $in: ['active', 'sold'] },
    });
    if (recentListingCount >= LISTING_BURST_NEW_ACCOUNT_MIN) {
      const accountAgeDays = await resolveSellerAccountAgeDays(product, sellerId);
      const newAccount =
        accountAgeDays !== null && accountAgeDays < LISTING_BURST_NEW_ACCOUNT_MAX_AGE_DAYS;
      if (newAccount) {
        riskScore += LISTING_BURST_NEW_ACCOUNT_WEIGHT;
        factors.push(LISTING_BURST_NEW_ACCOUNT_FACTOR);
      } else if (recentListingCount >= LISTING_BURST_MIN) {
        riskScore += LISTING_BURST_WEIGHT;
        factors.push(LISTING_BURST_FACTOR);
      }
    }
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

  // Generalized categories for non-admin surfaces (full factors stay
  // admin-only to avoid exposing internal thresholds).
  const riskFactorCategories = [...new Set(factors.map(mapFactorToCategory))];
  // The coarse bucket for the scam-text block is exposed in addition to the
  // natural category each factor maps to (matching the Phase-3 generalization
  // scheme — see README §7.9/§7.10).
  if (textScam.signals.length > 0 && !riskFactorCategories.includes(CONTENT_SCAM_CATEGORY)) {
    riskFactorCategories.push(CONTENT_SCAM_CATEGORY);
  }

  return {
    riskScore,
    riskLevel,
    factors,
    riskFactorCategories,
  };
};

/**
 * Derive the coarse v1 risk band from a 0-100 score (single source of truth
 * for the >=50 high / >=25 medium thresholds).
 */
const riskLevelFromScore = (score) => {
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
};

/**
 * v1/v2 fraud score fusion policy (README §8.4).
 *
 * - both v1 riskScore and v2 fraudProbability -> max(v1, round(v2*100)),
 *   fusionMode 'v1+v2-max'
 * - only v1 -> the v1 score, fusionMode 'v1'
 * - only v2 -> round(v2*100), fusionMode 'v2'
 *
 * Rationale: max() fusion is conservative — either engine alone can escalate;
 * neither can downgrade the other. Revisit as weighted fusion once v2 has
 * real-outcome validation.
 *
 * @param {Object} params
 * @param {number} [params.v1RiskScore]         v1 additive score (0-100)
 * @param {number} [params.v2FraudProbability]  v2 calibrated probability (0-1)
 * @returns {{ riskScore, riskLevel, fusionMode, v1RiskScore, v2FraudProbability }}
 */
const fuseFraudScores = ({ v1RiskScore = null, v2FraudProbability = null } = {}) => {
  const hasV1 = Number.isFinite(v1RiskScore);
  const hasV2 = Number.isFinite(v2FraudProbability);

  if (hasV1 && hasV2) {
    const v1 = clamp(Math.round(v1RiskScore), 0, 100);
    const v2 = clamp(Math.round(v2FraudProbability * 100), 0, 100);
    const fused = Math.max(v1, v2);
    return {
      riskScore: fused,
      riskLevel: riskLevelFromScore(fused),
      fusionMode: 'v1+v2-max',
      v1RiskScore: v1,
      v2FraudProbability,
    };
  }

  if (hasV1) {
    const v1 = clamp(Math.round(v1RiskScore), 0, 100);
    return {
      riskScore: v1,
      riskLevel: riskLevelFromScore(v1),
      fusionMode: 'v1',
      v1RiskScore: v1,
      v2FraudProbability: null,
    };
  }

  if (hasV2) {
    const v2 = clamp(Math.round(v2FraudProbability * 100), 0, 100);
    return {
      riskScore: v2,
      riskLevel: riskLevelFromScore(v2),
      fusionMode: 'v2',
      v1RiskScore: null,
      v2FraudProbability,
    };
  }

  return {
    riskScore: 0,
    riskLevel: 'low',
    fusionMode: 'v1',
    v1RiskScore: null,
    v2FraudProbability: null,
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

  const [candidateTotal, candidates] = await Promise.all([
    Product.countDocuments(candidateFilter),
    Product.find(candidateFilter)
      .select('title category images.cnnFeatures')
      .limit(MAX_CANDIDATES)
      .lean(),
  ]);
  if (candidateTotal > MAX_CANDIDATES) {
    console.warn(
      `[fraud] candidate pool truncated: ${candidateTotal} candidates, cap ${MAX_CANDIDATES} — coverage incomplete for category ${product.category || 'all'}`
    );
  }

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
  collectHashSet,
  fuseFraudScores,
  RISK_FACTOR_CATEGORIES,
  mapFactorToCategory,
  VISUAL_PRODUCT_SIMILARITY_SIGNAL,
  VISUAL_SIGNAL_WEIGHTS: IDENTITY_SIGNAL_WEIGHTS,
  IMAGE_TEXT_MISMATCH_SIGNAL,
  IMAGE_TEXT_MISMATCH_WEIGHT,
  classifyImageTextMatch,
  assessImageTextMismatch,
  CATEGORY_MISMATCH_SIGNAL,
  CATEGORY_MISMATCH_WEIGHT,
  CATEGORY_MISMATCH_MIN_CONFIDENCE,
  assessCategoryAgreement,
  CROSS_CATEGORY_IMAGE_REPOST_SIGNAL,
  CROSS_CATEGORY_IMAGE_REPOST_WEIGHT,
  CROSS_CATEGORY_SIM_THRESHOLD,
  CROSS_CATEGORY_SCAN_K,
  assessCrossCategoryImageRepost,
  LISTING_BURST_SIGNAL,
  LISTING_BURST_NEW_ACCOUNT_SIGNAL,
  LISTING_BURST_WEIGHT,
  LISTING_BURST_NEW_ACCOUNT_WEIGHT,
  resolveSellerAccountAgeDays,
};
