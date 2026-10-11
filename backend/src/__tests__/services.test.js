// Tests for pure/deterministic service functions.
// Uses table-driven test structure (it.each) for scalable edge case coverage.

const mongoose = require('mongoose');
const { server } = require('../server');
const User = require('../models/User');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Review = require('../models/Review');
const Sale = require('../models/Sale');
const Report = require('../models/Report');

// Services
const { calculateTrustScore } = require('../services/trustScore');
const { calculateRecommendedPrice } = require('../services/priceRecommendation');
const { detectRisk } = require('../services/fraudDetection');
const { convert, SUPPORTED, BASE } = require('../services/exchangeRates');
const { hammingDistance, similarity } = require('../services/imageHash');
const { findSimilar } = require('../services/similarProducts');
const { assessCondition, detectDamage, classifyProduct } = require('../services/computerVision');

describe('Service Unit Tests', () => {
  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // --- exchangeRates ---
  describe('exchangeRates.convert', () => {
    it.each([
      [100, 'USD', 'EUR', 92, 'basic USDâ†’EUR'],
      [0, 'USD', 'EUR', 0, 'zero amount returns zero'],
      [-5, 'USD', 'EUR', -5, 'negative amount returns as-is'],
      [100, 'USD', 'USD', 100, 'same currency returns same'],
      [100, 'XYZ', 'EUR', 92, 'unknown currency falls back to USD'],
      [100, 'USD', 'XYZ', 100, 'unknown target falls back to USD base'],
    ])('convert(%s, "%s", "%s") â‰ˆ %s (%s)', (amount, from, to, expected, desc) => {
      const rates = { USD: 1, EUR: 0.92, GBP: 0.79 };
      const result = convert(amount, from, to, rates);
      expect(result).toBeCloseTo(expected, 0);
    });
  });

  // --- imageHash ---
  describe('imageHash.hammingDistance', () => {
    it.each([
      ['0000000000000000', '0000000000000000', 0, 'identical hashes'],
      ['0000000000000000', 'ffffffffffffffff', 64, 'opposite bits'],
      ['0000000000000000', '0000000000000001', 1, 'one bit different'],
      ['0000000000000000', null, 64, 'null hash'],
      ['', '0000000000000000', 64, 'empty hash'],
    ])('hammingDistance("%s", "%s") = %s (%s)', (h1, h2, expected, desc) => {
      expect(hammingDistance(h1, h2)).toBe(expected);
    });
  });

  describe('imageHash.similarity', () => {
    it('returns 1.0 for identical hashes', () => {
      expect(similarity('0000000000000000', '0000000000000000')).toBe(1);
    });
    it('returns 0.0 for opposite hashes', () => {
      expect(similarity('0000000000000000', 'ffffffffffffffff')).toBe(0);
    });
  });

  // --- priceRecommendation ---
  describe('priceRecommendation.calculateRecommendedPrice', () => {
    it('returns insufficient_data when no inputs', async () => {
      const result = await calculateRecommendedPrice({
        category: null, brand: null, model: null,
        originalPrice: 0, yearsUsed: 0, condition: 'good',
      });
      expect(result.source).toBe('insufficient_data');
      expect(result.recommendedPrice).toBe(0);
    });

    it('uses depreciation model when originalPrice provided', async () => {
      const result = await calculateRecommendedPrice({
        category: { name: 'Electronics' }, brand: 'Apple', model: 'iPhone',
        originalPrice: 1000, yearsUsed: 1, condition: 'like-new',
      });
      expect(result.recommendedPrice).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.factors.length).toBeGreaterThan(0);
    });

    it('applies brand premium for Apple', async () => {
      const withApple = await calculateRecommendedPrice({
        category: { name: 'Electronics' }, brand: 'Apple',
        originalPrice: 1000, yearsUsed: 1, condition: 'good',
      });
      const withoutBrand = await calculateRecommendedPrice({
        category: { name: 'Electronics' }, brand: null,
        originalPrice: 1000, yearsUsed: 1, condition: 'good',
      });
      expect(withApple.recommendedPrice).toBeGreaterThan(withoutBrand.recommendedPrice);
    });

    it('applies damage penalty', async () => {
      const clean = await calculateRecommendedPrice({
        category: { name: 'Electronics' }, originalPrice: 500,
        yearsUsed: 0, condition: 'good', damageScore: 0,
      });
      const damaged = await calculateRecommendedPrice({
        category: { name: 'Electronics' }, originalPrice: 500,
        yearsUsed: 0, condition: 'good', damageScore: 80,
      });
      expect(damaged.recommendedPrice).toBeLessThan(clean.recommendedPrice);
    });

    it('uses comparables median when no originalPrice', async () => {
      const comparables = [
        { price: 100, condition: 'good' },
        { price: 120, condition: 'good' },
        { price: 90, condition: 'good' },
        { price: 110, condition: 'good' },
      ];
      const result = await calculateRecommendedPrice({
        category: null, originalPrice: 0, condition: 'good',
        comparableListings: comparables,
      });
      expect(result.recommendedPrice).toBeGreaterThan(0);
    });

    it('grants the comparables confidence bump on exactly one path (no original price)', async () => {
      const comparables = [
        { price: 100, condition: 'good' },
        { price: 120, condition: 'good' },
        { price: 90, condition: 'good' },
        { price: 110, condition: 'good' },
      ];
      // No original price: base 0.5 + 0.1 from the comparables base path.
      // The same-condition refinement must NOT add another +0.1, so 0.6.
      const result = await calculateRecommendedPrice({
        category: null, originalPrice: 0, condition: 'good',
        comparableListings: comparables,
      });
      expect(result.confidence).toBe(0.6);
    });

    it('grants the comparables confidence bump via refinement when an original price exists', async () => {
      const comparables = [
        { price: 100, condition: 'good' },
        { price: 120, condition: 'good' },
        { price: 90, condition: 'good' },
        { price: 110, condition: 'good' },
      ];
      // Depreciation base 0.5 + 0.2, then comparables corroborate via the
      // refinement blend (+0.1) — total 0.8. The comparables evidence is
      // counted once even though the same listing array is passed in.
      const result = await calculateRecommendedPrice({
        category: { name: 'Electronics' }, originalPrice: 1000,
        yearsUsed: 1, condition: 'good',
        comparableListings: comparables,
      });
      expect(result.confidence).toBe(0.8);
    });
  });

  // --- mlClient.blendWithMl ---
  describe('mlClient.blendWithMl', () => {
    const { blendWithMl, DEFAULT_ML_BLEND_WEIGHT } = require('../services/mlClient');

    it('blends local heuristic and ML estimate at the configured weight', () => {
      const local = { recommendedPrice: 100, minPrice: 85, maxPrice: 115, confidence: 0.6, factors: ['a'], explanation: 'e', source: 'heuristic' };
      const ml = { suggestedPrice: 200, priceRange: { min: 170, max: 230 }, explanation: 'ml' };
      const out = blendWithMl(local, ml, 0.5);
      expect(out.recommendedPrice).toBe(150);
      expect(out.minPrice).toBe(127.5);
      expect(out.maxPrice).toBe(172.5);
      expect(out.source).toBe('hybrid');
      expect(out.confidence).toBe(0.6);
    });

    it('defaults to the ML weight env (0.7)', () => {
      const local = { recommendedPrice: 100, minPrice: 85, maxPrice: 115, factors: [] };
      const ml = { suggestedPrice: 200, priceRange: { min: 170, max: 230 } };
      expect(DEFAULT_ML_BLEND_WEIGHT).toBe(0.7);
      expect(blendWithMl(local, ml).recommendedPrice).toBe(170);
    });

    it('returns local baseline untouched when ML estimate is missing', () => {
      const local = { recommendedPrice: 100, minPrice: 85, maxPrice: 115, confidence: 0.6, factors: [], source: 'heuristic' };
      const out = blendWithMl(local, { suggestedPrice: null });
      expect(out.source).toBe('heuristic');
      expect(out.recommendedPrice).toBe(100);
    });

    it('returns ML estimate alone when no local baseline exists', () => {
      const local = { recommendedPrice: 0, minPrice: 0, maxPrice: 0, confidence: 0 };
      const ml = { suggestedPrice: 200, priceRange: { min: 170, max: 230 }, explanation: 'ml-only' };
      const out = blendWithMl(local, ml, 0.7);
      expect(out.source).toBe('ml-service');
      expect(out.recommendedPrice).toBe(200);
    });
  });

  // --- trustScore (requires DB) ---
  describe('trustScore.calculateTrustScore', () => {
    it('returns score 0 for non-existent user', async () => {
      const result = await calculateTrustScore(new mongoose.Types.ObjectId());
      expect(result.score).toBe(0);
      expect(result.level).toBe('unknown');
    });

    it('returns positive score for user with history', async () => {
      const user = await User.create({
        name: 'Trust Test', email: 'trust@test.com', password: 'pass123',
        role: 'seller', averageResponseMinutes: 30,
      });
      const category = await Category.create({ name: 'Test', slug: 'test-trust', icon: 'box' });
      await Product.create({
        title: 'Product 1', description: 'A'.repeat(150), price: 100,
        category: category._id, images: [{ url: 'http://x.com/1.jpg', publicId: 'a' }],
        seller: user._id,
      });
      await Sale.create({
        product: category._id, seller: user._id, buyer: user._id,
        salePrice: 100, netAmount: 100,
      });
      await Review.create({
        seller: user._id, buyer: user._id, rating: 5,
      });

      const result = await calculateTrustScore(user._id);
      expect(result.score).toBeGreaterThan(0);
      expect(result.breakdown).toBeDefined();
      expect(['new', 'developing', 'established', 'trusted', 'excellent']).toContain(result.level);
    });
  });

  // --- fraudDetection (requires DB) ---
  describe('fraudDetection.detectRisk', () => {
    it('returns low risk for clean product', async () => {
      const seller = await User.create({
        name: 'Clean', email: 'clean@test.com', password: 'pass123',
        role: 'seller', createdAt: new Date(Date.now() - 365 * 86400000),
      });
      const category = await Category.create({ name: 'Test', slug: 'test-fraud', icon: 'box' });
      const product = await Product.create({
        title: 'Clean Product', description: 'Unique description here',
        price: 100, originalPrice: 200, category: category._id,
        images: [{ url: 'http://x.com/1.jpg', publicId: 'a' }],
        seller: seller._id,
      });
      const result = await detectRisk({
        product, hashes: ['aaaa'], aiAnalysis: { damageScore: 10 },
      });
      expect(result.riskLevel).toBe('low');
      expect(result.riskScore).toBeLessThan(25);
    });

    it('flags suspiciously low price', async () => {
      const seller = await User.create({
        name: 'Suspicious', email: 'susp@test.com', password: 'pass123',
        role: 'seller', createdAt: new Date(Date.now() - 365 * 86400000),
      });
      const category = await Category.create({ name: 'Test', slug: 'test-fraud2', icon: 'box' });
      const product = await Product.create({
        title: 'Cheap Product', description: 'Unique description for fraud test',
        price: 10, originalPrice: 200, category: category._id,
        images: [{ url: 'http://x.com/1.jpg', publicId: 'a' }],
        seller: seller._id,
      });
      const result = await detectRisk({
        product, hashes: [], aiAnalysis: { damageScore: 0 },
      });
      expect(result.riskScore).toBeGreaterThanOrEqual(25);
      expect(result.factors.some((f) => f.includes('low'))).toBe(true);
    });

    it('continuous pricing: scales points near the 15% low-price boundary', async () => {
      const seller = await User.create({
        name: 'Boundary', email: 'boundary@test.com', password: 'pass123',
        role: 'seller', createdAt: new Date(Date.now() - 365 * 86400000),
      });
      const category = await Category.create({ name: 'Test', slug: 'test-fraud-boundary', icon: 'box' });
      // 149/1000 = 14.9% -> just below 15%: gets a small nonzero penalty (1pt).
      const product = await Product.create({
        title: 'Boundary Product', description: 'Boundary description for fraud test',
        price: 149, originalPrice: 1000, category: category._id,
        images: [{ url: 'http://x.com/1.jpg', publicId: 'a' }],
        seller: seller._id,
      });
      const result = await detectRisk({
        product, hashes: [], aiAnalysis: { damageScore: 0 },
      });
      expect(result.factors.some((f) => f.includes('suspiciously low'))).toBe(true);
      expect(result.riskFactorCategories).toContain('pricing_anomaly');
      // Only the pricing penalty plus rating/response/complaint baselines.
      expect(result.riskScore).toBeGreaterThan(0);
      expect(result.riskScore).toBeLessThan(25);
    });

    it('continuous pricing: exact 15% ratio gets no low-price penalty', async () => {
      const seller = await User.create({
        name: 'Exact Ratio', email: 'exact-ratio@test.com', password: 'pass123',
        role: 'seller', createdAt: new Date(Date.now() - 365 * 86400000),
      });
      const category = await Category.create({ name: 'Test', slug: 'test-fraud-ratio', icon: 'box' });
      const product = await Product.create({
        title: 'Exact Ratio Product', description: 'Exact ratio description for fraud test',
        price: 150, originalPrice: 1000, category: category._id,
        images: [{ url: 'http://x.com/1.jpg', publicId: 'a' }],
        seller: seller._id,
      });
      const result = await detectRisk({
        product, hashes: [], aiAnalysis: { damageScore: 0 },
      });
      expect(result.factors.some((f) => f.includes('suspiciously low'))).toBe(false);
      expect(result.factors.some((f) => f.includes('above original'))).toBe(false);
      expect(result.riskFactorCategories).not.toContain('pricing_anomaly');
    });

    it('flags high-value listing from new account', async () => {
      const seller = await User.create({
        name: 'New Seller', email: 'new@test.com', password: 'pass123',
        role: 'seller', createdAt: new Date(), // brand new
      });
      const category = await Category.create({ name: 'Test', slug: 'test-fraud3', icon: 'box' });
      const product = await Product.create({
        title: 'Expensive Product', description: 'Yet another unique description here',
        price: 10000, originalPrice: 10000, category: category._id,
        images: [{ url: 'http://x.com/1.jpg', publicId: 'a' }],
        seller: seller._id,
      });
      const result = await detectRisk({
        product, hashes: [], aiAnalysis: { damageScore: 0 },
      });
      expect(result.riskScore).toBeGreaterThanOrEqual(15);
      expect(result.factors.some((f) => f.includes('new account'))).toBe(true);
    });
  });

  // --- computerVision ---
  describe('computerVision.assessCondition', () => {
    it('returns no-evidence (null score) when sharp unavailable and buffer empty', async () => {
      // With a minimal valid buffer
      const buf = Buffer.alloc(100, 0x80);
      const result = await assessCondition(buf);
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('label');
      // Explicit no-evidence semantics: when visual analysis is unavailable
      // the score is null (never a fabricated number) and callers must show
      // "insufficient evidence" instead.
      expect(result.available).toBe(false);
      expect(result.score).toBeNull();
      expect(result.label).toBeNull();
    });
  });

  describe('computerVision.detectDamage', () => {
    const sharpLib = require('sharp');

    const rawJpeg = (raw, width, height) =>
      sharpLib(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();

    const patternJpeg = (size, fn) => {
      const raw = Buffer.alloc(size * size * 3);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const v = fn(x, y);
          const i = (y * size + x) * 3;
          raw[i] = raw[i + 1] = raw[i + 2] = v;
        }
      }
      return rawJpeg(raw, size, size);
    };

    it('returns no-evidence (null score) when the buffer cannot be decoded', async () => {
      const result = await detectDamage(Buffer.alloc(100, 0x80));
      expect(result.available).toBe(false);
      expect(result.score).toBeNull();
      expect(result.level).toBeNull();
    });

    it('scores a smooth uniform surface as low damage', async () => {
      const buf = await sharpLib({
        create: { width: 128, height: 128, channels: 3, background: { r: 128, g: 128, b: 128 } },
      }).jpeg().toBuffer();
      const result = await detectDamage(buf);
      expect(result.level).toBe('low');
      expect(result.score).toBe(0);
      expect(result.factors).toContain('Smooth surface');
    });

    it('reaches the high band (>= 50) on a dense high-edge surface', async () => {
      const buf = await patternJpeg(64, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
      const result = await detectDamage(buf);
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.level).toBe('high');
    });

    it('does not count high contrast / low brightness as damage on a smooth surface', async () => {
      const buf = await patternJpeg(64, (x) => (x < 32 ? 0 : 255));
      const result = await detectDamage(buf);
      expect(result.score).toBe(0);
      expect(result.factors).not.toContain('Possible surface scratches detected');
    });
  });

  describe('computerVision.classifyProduct', () => {
    it('classifies electronics from title keywords', async () => {
      const buf = Buffer.alloc(100, 0x80);
      const result = await classifyProduct(buf, { title: 'iPhone 14 Pro' });
      expect(result.category).toBe('Electronics');
      expect(result.confidence).toBeGreaterThan(0);
    }, 90000);

    it('classifies fashion from title keywords', async () => {
      const buf = Buffer.alloc(100, 0x80);
      const result = await classifyProduct(buf, { title: 'Nike Running Shoes' });
      expect(result.category).toBe('Fashion');
    });

    it('returns Other for unmatched keywords', async () => {
      const buf = Buffer.alloc(100, 0x80);
      const result = await classifyProduct(buf, { title: 'xyzzy12345' });
      expect(result.category).toBe('Other');
    });
  });
});
