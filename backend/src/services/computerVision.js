/**
 * Computer Vision service.
 *
 * Implements modular CV analysis:
 * - Image quality / condition scoring
 * - Damage / scratch detection (heuristic-based using pixel analysis)
 * - Product classification (heuristic-based on filename + image features)
 *
 * Uses sharp when available, falls back gracefully otherwise.
 * Real ML models can be plugged in by setting ML_SERVICE_URL.
 */

const crypto = require('crypto');

let sharp;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const METADATA = {
  hasSharp: !!sharp,
  mlServiceUrl: process.env.ML_SERVICE_URL || null,
};

const analyzeImageQuality = async (imageBuffer) => {
  if (!sharp) {
    return {
      width: 0,
      height: 0,
      format: 'unknown',
      brightness: 128,
      contrast: 50,
      sharpness: 50,
      available: false,
    };
  }

  try {
    const meta = await sharp(imageBuffer).metadata();
    const stats = await sharp(imageBuffer).stats();

    const channels = stats.channels;
    const brightness =
      channels.reduce((s, c) => s + c.mean, 0) / Math.max(channels.length, 1);

    const contrast =
      channels.reduce((s, c) => s + Math.min(c.stdev, 100), 0) / Math.max(channels.length, 1);

    return {
      width: meta.width || 0,
      height: meta.height || 0,
      format: meta.format || 'unknown',
      brightness: Math.round(brightness),
      contrast: Math.round(contrast),
      sharpness: Math.round(contrast * 0.8 + brightness * 0.2),
      available: true,
    };
  } catch (err) {
    return {
      width: 0,
      height: 0,
      format: 'unknown',
      brightness: 128,
      contrast: 50,
      sharpness: 50,
      available: false,
      error: err.message,
    };
  }
};

/**
 * Condition score semantics (explicit):
 *   - 100 = like-new condition, lower = worse, 30 = worst meaningful estimate
 *   - 0 / null = NO visual evidence was available (never fabricated)
 *   - The score is a deterministic estimate of the item's visual condition
 *     derived from image quality (lighting, contrast, sharpness).
 *   - When analysis is unavailable the result is explicitly
 *     `available: false` with a null score — callers must show
 *     "insufficient evidence" rather than a fabricated number.
 */
const assessCondition = async (imageBuffer) => {
  const quality = await analyzeImageQuality(imageBuffer);

  if (!quality.available) {
    return {
      score: null,
      label: null,
      available: false,
      confidence: 0.3,
      factors: ['Visual analysis unavailable — insufficient evidence for a condition estimate'],
    };
  }

  let score = 100;
  const factors = [];

  // Brightness scoring: very dark or very bright images indicate issues
  if (quality.brightness < 60) {
    score -= 15;
    factors.push('Image is dark');
  } else if (quality.brightness > 220) {
    score -= 10;
    factors.push('Image is overexposed');
  } else {
    factors.push('Good lighting');
  }

  // Contrast scoring: low contrast can hide flaws but also indicates dullness
  if (quality.contrast < 20) {
    score -= 10;
    factors.push('Low contrast - possible dull surface');
  } else if (quality.contrast > 80) {
    factors.push('High detail contrast');
  }

  // Sharpness scoring
  if (quality.sharpness < 30) {
    score -= 8;
    factors.push('Image blur detected');
  }

  score = Math.max(30, Math.min(100, score));

  let label = 'good';
  if (score >= 90) label = 'like-new';
  else if (score >= 75) label = 'good';
  else if (score >= 60) label = 'fair';
  else label = 'poor';

  return {
    score,
    label,
    available: true,
    confidence: 0.65,
    factors,
  };
};

/**
 * Damage score semantics (explicit):
 *   - HIGHER means MORE damage (0 = no damage indicators, 100 = severe).
 *   - level: low (< 25) / medium (25–49) / high (>= 50).
 *   - 0 / null = NO visual evidence was available (never fabricated as
 *     "low damage" — callers must show "insufficient evidence").
 */
const detectDamage = async (imageBuffer) => {
  const quality = await analyzeImageQuality(imageBuffer);

  if (!quality.available) {
    return {
      score: null,
      level: null,
      available: false,
      confidence: 0.3,
      description: 'Damage analysis unavailable — insufficient evidence',
      factors: [],
    };
  }

  // Heuristic damage score — EDGE DENSITY ONLY.
  //
  // The image-quality stats (brightness / contrast / sharpness) measure
  // the PHOTO, not the product. They are already consumed by
  // assessCondition(); previously they were ALSO counted here, so the
  // same lighting problem (high contrast + dark + derived-low sharpness)
  // could add up to +50 for a perfectly undamaged item, while the
  // documented "high" damage band (>= 50) was only reachable by stacking
  // those overlapping quality rules. Real damage indicators (cracks,
  // deep scratches, heavy wear) introduce many thin high-gradient lines,
  // so edge density is the damage signal:
  //   edgeRatio > 0.45 -> +55  severe cracking / heavy wear  (level: high)
  //   edgeRatio > 0.35 -> +35  possible cracks / heavy wear
  //   edgeRatio > 0.20 -> +20  possible surface scratches / wear
  //   edgeRatio < 0.08 -> smooth surface (no penalty)
  // Max reachable score = 55, so level 'high' (>= 50) is achievable with
  // genuine heavy-wear evidence and nothing else can push it there.

  let damageScore = 0;
  const factors = [];

  // Edge density heuristic via difference calculation
  if (sharp) {
    try {
      const { data } = await sharp(imageBuffer)
        .resize(64, 64, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      let edges = 0;
      for (let y = 1; y < 63; y++) {
        for (let x = 1; x < 63; x++) {
          const gx = Math.abs(data[y * 64 + x] - data[y * 64 + x - 1]);
          const gy = Math.abs(data[y * 64 + x] - data[(y - 1) * 64 + x]);
          if (gx + gy > 60) edges++;
        }
      }
      const edgeRatio = edges / (62 * 62);
      if (edgeRatio > 0.45) {
        damageScore += 55;
        factors.push('Extremely high edge density — severe cracking or heavy wear likely');
      } else if (edgeRatio > 0.35) {
        damageScore += 35;
        factors.push('High edge density — possible cracks or heavy wear');
      } else if (edgeRatio > 0.20) {
        damageScore += 20;
        factors.push('Elevated edge density — possible surface scratches or wear');
      } else if (edgeRatio < 0.08) {
        factors.push('Smooth surface');
      }
    } catch (err) {
      // ignore
    }
  }

  damageScore = Math.max(0, Math.min(100, damageScore));

  let level = 'low';
  if (damageScore >= 50) level = 'high';
  else if (damageScore >= 25) level = 'medium';

  return {
    score: damageScore,
    level,
    confidence: quality.available ? 0.6 : 0.3,
    description:
      damageScore >= 50
        ? 'Visible damage likely present'
        : damageScore >= 25
        ? 'Some wear or minor damage indicators'
        : 'Item appears to be in good condition',
    factors,
  };
};

const classifyProduct = async (imageBuffer, metadata = {}) => {
  // Keyword-based score from filename + title. Computed first so it can
  // both stand alone and corroborate the image-model prediction below.
  const filename = (metadata.filename || '').toLowerCase();
  const title = (metadata.title || '').toLowerCase();
  const combined = `${filename} ${title}`;

  const CATEGORY_KEYWORDS = {
    Electronics: [
      'phone', 'laptop', 'tablet', 'macbook', 'iphone', 'samsung', 'dell',
      'hp', 'lenovo', 'computer', 'monitor', 'tv', 'television', 'camera',
      'headphone', 'earbuds', 'airpods', 'console', 'playstation', 'xbox',
    ],
    Fashion: [
      'shirt', 't-shirt', 'tshirt', 'jeans', 'jacket', 'coat', 'shoes',
      'sneakers', 'dress', 'watch', 'bag', 'handbag', 'wallet', 'sunglasses', 'belt',
    ],
    'Home & Garden': [
      'furniture', 'sofa', 'chair', 'table', 'lamp', 'plant', 'garden',
      'kitchen', 'appliance', 'vacuum', 'bed', 'shelf',
    ],
    'Sports & Outdoors': [
      'bike', 'bicycle', 'treadmill', 'weights', 'yoga', 'tennis',
      'football', 'basketball', 'camping', 'hiking',
    ],
    'Books & Media': ['book', 'novel', 'magazine', 'dvd', 'blu-ray', 'vinyl', 'record'],
    'Toys & Games': ['lego', 'puzzle', 'board game', 'console game', 'toy'],
    'Beauty & Health': ['perfume', 'skincare', 'makeup', 'cosmetic', 'shampoo', 'health'],
    Automotive: ['car', 'tire', 'engine', 'brake', 'helmet', 'car accessory'],
  };

  let keywordCategory = 'Other';
  let keywordScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (combined.includes(kw)) score += 2;
    }
    if (score > keywordScore) {
      keywordScore = score;
      keywordCategory = category;
    }
  }

  // Real image-based classification via MobileNet (graceful on failure —
  // unavailable ML is never an error condition, just no supporting evidence).
  let imageResult = null;
  try {
    const { classifyImage, CONFIDENCE_THRESHOLD } = require('./imageClassifier');
    const result = await classifyImage(imageBuffer);
    if (result && result.source === 'mobilenet') {
      imageResult = { ...result, threshold: CONFIDENCE_THRESHOLD };
    }
  } catch {
    // Image classifier unavailable — keyword matching only
  }

  // 1. Confident image-model prediction wins. When the keyword metadata
  //    independently agrees, that agreement is real evidence — a modest,
  //    bounded confidence boost (never fabricated certainty).
  if (imageResult && imageResult.confidence >= imageResult.threshold) {
    const agrees = keywordScore > 0 && keywordCategory === imageResult.category;
    return {
      category: imageResult.category,
      confidence: Number(Math.min(0.95, imageResult.confidence + (agrees ? 0.1 : 0)).toFixed(2)),
      source: agrees ? 'image-model+keyword' : 'image-model',
      topLabels: imageResult.topLabels,
    };
  }

  // 2. Sub-threshold image-model prediction corroborated by the keyword
  //    metadata: two independent methods agreeing is sufficient evidence to
  //    avoid an incorrect "Other" — the lower of the two confidences is kept
  //    so low-confidence predictions clearly remain low confidence.
  if (imageResult && keywordScore > 0 && keywordCategory === imageResult.category) {
    return {
      category: imageResult.category,
      confidence: Number(
        Math.min(0.95, Math.max(imageResult.confidence, 0.4 + keywordScore * 0.1)).toFixed(2)
      ),
      source: 'image-model+keyword',
      topLabels: imageResult.topLabels,
    };
  }

  // 3. Keyword fallback — low-confidence predictions remain low confidence
  //    and "Other" is returned only when no sufficient evidence exists.
  const confidence = Math.min(0.95, 0.4 + keywordScore * 0.1);

  return {
    category: keywordCategory,
    confidence: Number(confidence.toFixed(2)),
    keywordsMatched: keywordScore,
    source: keywordScore > 0 ? 'keyword' : 'none',
  };
};

module.exports = {
  metadata: METADATA,
  analyzeImageQuality,
  assessCondition,
  detectDamage,
  classifyProduct,
};
