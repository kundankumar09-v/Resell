/**
 * Price Recommendation Service
 *
 * Uses a multi-factor heuristic algorithm with transparent reasoning.
 * Falls back gracefully when insufficient comparable data exists.
 *
 * Inputs:
 *  - category
 *  - brand
 *  - model
 *  - specifications
 *  - original price (MSRP / retail)
 *  - years used
 *  - condition
 *  - CV condition score
 *  - damage score
 *  - comparable listings
 *
 * Output:
 *  - recommendedPrice
 *  - minPrice, maxPrice
 *  - confidence
 *  - explanation + factors
 */

const CONDITION_FACTOR = {
  new: 0.95,
  'like-new': 0.82,
  good: 0.65,
  fair: 0.45,
  poor: 0.25,
};

const ANNUAL_DEPRECIATION = {
  Electronics: 0.18,
  'Mobile Phones': 0.22,
  'Computers & Laptops': 0.16,
  Fashion: 0.30,
  'Home & Garden': 0.10,
  'Sports & Outdoors': 0.15,
  'Books & Media': 0.25,
  'Toys & Games': 0.20,
  'Beauty & Health': 0.12,
  Automotive: 0.10,
  Other: 0.15,
};

const BRAND_PREMIUM = {
  apple: 1.1,
  samsung: 1.02,
  sony: 1.03,
  dell: 1.0,
  hp: 1.0,
  lenovo: 1.0,
  nike: 1.05,
  adidas: 1.04,
  canon: 1.03,
  // default 1.0
};

const conditionMultiplier = (condition) => CONDITION_FACTOR[condition] ?? 0.6;

const depreciationForCategory = (categoryName) => {
  if (!categoryName) return ANNUAL_DEPRECIATION.Other;
  return ANNUAL_DEPRECIATION[categoryName] ?? ANNUAL_DEPRECIATION.Other;
};

const brandMultiplier = (brand) => {
  if (!brand) return 1.0;
  return BRAND_PREMIUM[brand.toLowerCase()] ?? 1.0;
};

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

/**
 * Trim a sorted numeric array using the interquartile range (IQR) method.
 * Returns [] if fewer than 4 values (not enough to compute quartiles reliably).
 */
const trimIQR = (sortedAsc) => {
  if (!Array.isArray(sortedAsc) || sortedAsc.length < 4) return sortedAsc || [];
  const q1 = sortedAsc[Math.floor(sortedAsc.length * 0.25)];
  const q3 = sortedAsc[Math.floor(sortedAsc.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return sortedAsc.filter((v) => v >= lo && v <= hi);
};

/**
 * Calculate recommended price.
 */
const calculateRecommendedPrice = async ({
  category,
  brand,
  model,
  originalPrice,
  yearsUsed = 0,
  condition = 'good',
  cvConditionScore = null,
  damageScore = null,
  specifications = [],
  comparableListings = [],
}) => {
  const factors = [];
  let confidence = 0.5;
  let source = 'heuristic';

  const categoryName = typeof category === 'object' ? category?.name : category;
  const original = Number(originalPrice) || 0;
  const years = Math.max(0, Number(yearsUsed) || 0);
  const specsArr = Array.isArray(specifications) ? specifications : [];

  let recommendedPrice = 0;

  if (original > 0) {
    // Depreciation-based estimate
    const depRate = depreciationForCategory(categoryName);
    let depreciated = original * Math.pow(1 - depRate, years);

    // Apply brand premium
    depreciated *= brandMultiplier(brand);

    // Apply condition multiplier
    const cm = conditionMultiplier(condition);
    depreciated *= cm;

    factors.push(
      `Started from original price (${original.toFixed(0)}) and applied ${(depRate * 100).toFixed(
        0
      )}% annual depreciation over ${years} year(s)`
    );
    factors.push(`Brand factor: ${brandMultiplier(brand).toFixed(2)}x for ${brand || 'unknown'}`);
    factors.push(`Condition factor: ${cm.toFixed(2)}x for "${condition}" condition`);

    recommendedPrice = depreciated;
    confidence += 0.2;
  } else if (comparableListings.length > 0) {
    // No original price; use median of comparables (with IQR outlier removal)
    const rawPrices = comparableListings
      .map((p) => Number(p.price) || 0)
      .filter((p) => p > 0)
      .sort((a, b) => a - b);

    const trimmed = trimIQR(rawPrices);
    const prices = trimmed.length >= 2 ? trimmed : rawPrices;
    const outlierCount = rawPrices.length - prices.length;

    if (prices.length > 0) {
      const median = prices[Math.floor(prices.length / 2)];
      recommendedPrice = median * conditionMultiplier(condition);
      const outlierNote = outlierCount > 0 ? ` (${outlierCount} outlier(s) removed)` : '';
      factors.push(`Median of ${prices.length} comparable listings${outlierNote} used as base`);
    }
    confidence += 0.1;
  }

  // Adjust using CV condition score if available
  if (cvConditionScore !== null && cvConditionScore !== undefined) {
    const cvFactor = (cvConditionScore / 100) * 0.4 + 0.6; // map 0..100 to 0.6..1.0
    recommendedPrice *= cvFactor;
    factors.push(`CV condition score ${cvConditionScore}/100 adjusted price by factor ${cvFactor.toFixed(2)}x`);
    confidence += 0.1;
  }

  // Damage penalty
  if (damageScore !== null && damageScore !== undefined && damageScore > 0) {
    const damageFactor = Math.max(0.7, 1 - damageScore / 250);
    recommendedPrice *= damageFactor;
    factors.push(`Damage score ${damageScore}/100 reduced price by factor ${damageFactor.toFixed(2)}x`);
    confidence += 0.05;
  }

  // Specification boost (premium specs add value)
  if (specsArr.length > 0) {
    const specText = specsArr.map((s) => `${s.key}:${s.value}`).join(' ').toLowerCase();
    const hasPremiumSpecs =
      /pro|max|ultra|plus|premium|256|512|1tb|16gb|32gb/i.test(specText);
    if (hasPremiumSpecs) {
      recommendedPrice *= 1.06;
      factors.push('Premium specification detected — 6% value boost applied');
    }
  }

  // Comparable listings refinement
  if (comparableListings.length >= 3) {
    const similarPrices = comparableListings
      .filter((p) => p.condition === condition)
      .map((p) => Number(p.price) || 0)
      .filter((p) => p > 0)
      .sort((a, b) => a - b);

    if (similarPrices.length > 0) {
      const medianComparable = similarPrices[Math.floor(similarPrices.length / 2)];
      // Weighted blend: 70% our calc, 30% market comparable
      const blended = recommendedPrice * 0.7 + medianComparable * 0.3;
      factors.push(`Blended with median of ${similarPrices.length} same-condition comparables`);
      recommendedPrice = blended;
      // Confidence from comparables is granted ONCE: when an original price
      // exists, this refinement is the comparables evidence (market
      // corroboration of an independent depreciation estimate). When there
      // was NO original price the median-of-comparables base path above
      // already granted the comparables bump — granting it again here would
      // double-count the same data.
      if (original > 0) confidence += 0.1;
    }
  }

  if (recommendedPrice <= 0) {
    return {
      recommendedPrice: 0,
      minPrice: 0,
      maxPrice: 0,
      confidence: 0,
      explanation:
        'Insufficient data to recommend a price. Provide the original (MSRP) price, or wait for more comparable listings in this category.',
      factors: ['No original price and no comparable listings found'],
      source: 'insufficient_data',
    };
  }

  // Build price range (±15%)
  const range = 0.15;
  const minPrice = Math.max(1, recommendedPrice * (1 - range));
  const maxPrice = recommendedPrice * (1 + range);

  confidence = clamp(confidence, 0, 0.95);

  const explanation =
    `Based on a ${original > 0 ? 'depreciation model' : 'comparable listings'} ` +
    `adjusted by condition, brand, age, visual condition analysis, and ${comparableListings.length} ` +
    `comparable listings.`;

  const result = {
    recommendedPrice: Math.round(recommendedPrice * 100) / 100,
    minPrice: Math.round(minPrice * 100) / 100,
    maxPrice: Math.round(maxPrice * 100) / 100,
    confidence: Number(confidence.toFixed(2)),
    explanation,
    factors,
    source,
  };

  return result;
};

module.exports = { calculateRecommendedPrice };
