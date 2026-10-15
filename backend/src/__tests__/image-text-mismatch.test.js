/**
 * Image–text mismatch signal — unit + integration tests.
 *
 * The signal compares the listing's CLIP *image* embedding with the CLIP
 * *text* embedding of its title (POST /text-embed). It is supporting-only:
 *   - only the STRONG band (< 0.20) fires (+15, category content_mismatch);
 *   - the weak band [0.20, 0.30) adds nothing (shadow/logging only);
 *   - short or purely generic titles are skipped;
 *   - a missing text embedding (ML service down) skips silently.
 *
 * The embedding-based unit tests build mock vectors whose cosine is known
 * exactly: cos(vec(k), vec(512)) = sqrt(k / 512).
 */

const mongoose = require('mongoose');
const { server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const {
  detectRisk,
  classifyImageTextMatch,
  assessImageTextMismatch,
  IMAGE_TEXT_MISMATCH_SIGNAL,
} = require('../services/fraudDetection');

/** A 512-D vector with the first `k` components set to 1 (magnitude sqrt(k)). */
const vec = (k, length = 512) => {
  const v = new Array(length).fill(0);
  for (let i = 0; i < k; i++) v[i] = 1;
  return v;
};

describe('Image–text mismatch signal', () => {
  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // ── Pure classification (no DB) ────────────────────────────────────────────

  describe('classifyImageTextMatch / assessImageTextMismatch', () => {
    it('a strong match (cosine 1.0) never fires', () => {
      const result = assessImageTextMismatch({
        imageEmbedding: vec(512),
        textEmbedding: vec(512),
        title: 'iPhone 15 Pro Max 256GB',
      });
      expect(result.similarity).toBeCloseTo(1, 5);
      expect(result.band).toBe('match');
      expect(result.signal).toBeNull();
    });

    it('a borderline mock match (cosine 0.5) never fires', () => {
      const result = assessImageTextMismatch({
        imageEmbedding: vec(512),
        textEmbedding: vec(128), // cosine = sqrt(128/512) = 0.5
        title: 'iPhone 15 Pro Max 256GB',
      });
      expect(result.similarity).toBeCloseTo(0.5, 5);
      expect(result.band).toBe('match');
      expect(result.signal).toBeNull();
    });

    it('unrelated embeddings (cosine < 0.20) fire the strong-mismatch signal', () => {
      const result = assessImageTextMismatch({
        imageEmbedding: vec(512),
        textEmbedding: vec(10), // cosine ~= 0.1397
        title: 'Nike Air Jordan 1 Chicago',
      });
      expect(result.similarity).toBeLessThan(0.2);
      expect(result.band).toBe('strong_mismatch');
      expect(result.signal).toBe(IMAGE_TEXT_MISMATCH_SIGNAL);
    });

    it('the weak band [0.20, 0.30) adds no signal', () => {
      const result = assessImageTextMismatch({
        imageEmbedding: vec(512),
        textEmbedding: vec(25), // cosine ~= 0.221
        title: 'Nike Air Jordan 1 Chicago',
      });
      expect(result.similarity).toBeGreaterThanOrEqual(0.2);
      expect(result.similarity).toBeLessThan(0.3);
      expect(result.band).toBe('weak_match');
      expect(result.signal).toBeNull();
    });

    it('a missing text embedding (ML service down) is skipped, never throws', () => {
      const result = assessImageTextMismatch({
        imageEmbedding: vec(512),
        textEmbedding: null,
        title: 'Nike Air Jordan 1 Chicago',
      });
      expect(result.band).toBe('unavailable');
      expect(result.signal).toBeNull();
      expect(result.similarity).toBeNull();
    });

    it('a generic title ("laptop for sale") is never evaluated', () => {
      const result = assessImageTextMismatch({
        imageEmbedding: vec(512),
        textEmbedding: vec(10),
        title: 'laptop for sale',
      });
      expect(result.band).toBe('skipped_generic_title');
      expect(result.signal).toBeNull();
    });

    it('a short title (under 3 words) is never evaluated', () => {
      const result = classifyImageTextMatch({ similarity: 0.05, title: 'phone' });
      expect(result.band).toBe('skipped_generic_title');
      expect(result.signal).toBeNull();
    });
  });

  // ── detectRisk integration (DB-backed) ─────────────────────────────────────

  const makeSeller = () =>
    User.create({
      name: 'Seller',
      email: `seller-${Date.now()}-${Math.random()}@test.com`,
      password: 'pass123',
      role: 'seller',
      createdAt: new Date(Date.now() - 365 * 86400000), // old account
    });

  const makeCategory = (slug) => Category.create({ name: slug, slug, icon: 'phone' });

  const makeProduct = ({ seller, category, title, description = 'Great condition, barely used.' }) =>
    Product.create({
      title,
      description,
      price: 100,
      category: category._id,
      images: [{ url: 'http://x.com/1.jpg', publicId: 'x1' }],
      seller: seller._id,
      status: 'active',
    });

  it('fires +15 with the content_mismatch category on a strong mismatch', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('mismatch-strong');
    const product = await makeProduct({
      seller,
      category,
      title: 'Nike Air Jordan 1 Chicago',
    });

    const result = await detectRisk({
      product,
      hashes: [],
      aiAnalysis: {},
      imageTextSimilarity: 0.12,
    });

    expect(result.factors.some((f) => /does not match its title/.test(f))).toBe(true);
    expect(result.riskFactorCategories).toContain('content_mismatch');
    expect(result.riskScore).toBeGreaterThanOrEqual(15);
  });

  it('does not fire when the image and title match', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('mismatch-match');
    const product = await makeProduct({ seller, category, title: 'Nike Air Jordan 1 Chicago' });

    const result = await detectRisk({
      product,
      hashes: [],
      aiAnalysis: {},
      imageTextSimilarity: 0.62,
    });

    expect(result.factors.some((f) => /does not match its title/.test(f))).toBe(false);
    expect(result.riskScore).toBe(0);
  });

  it('the weak band adds no risk points', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('mismatch-weak');
    const product = await makeProduct({ seller, category, title: 'Nike Air Jordan 1 Chicago' });

    const result = await detectRisk({
      product,
      hashes: [],
      aiAnalysis: {},
      imageTextSimilarity: 0.25,
    });

    expect(result.factors.some((f) => /does not match its title/.test(f))).toBe(false);
    expect(result.riskScore).toBe(0);
  });

  it('falls back to the persisted aiAnalysis.imageTextSimilarity', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('mismatch-persisted');
    const product = await makeProduct({ seller, category, title: 'Nike Air Jordan 1 Chicago' });

    const result = await detectRisk({
      product,
      hashes: [],
      aiAnalysis: { imageTextSimilarity: 0.1 },
    });

    expect(result.factors.some((f) => /does not match its title/.test(f))).toBe(true);
  });

  it('skips silently when the ML service is down (no similarity available)', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('mismatch-mldown');
    const product = await makeProduct({ seller, category, title: 'Nike Air Jordan 1 Chicago' });

    const result = await detectRisk({ product, hashes: [], aiAnalysis: {} });

    expect(result.factors.some((f) => /does not match its title/.test(f))).toBe(false);
    expect(result.riskScore).toBe(0);
  });

  it('never fires on a generic title even with a low similarity', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('mismatch-generic');
    const product = await makeProduct({ seller, category, title: 'laptop for sale' });

    const result = await detectRisk({
      product,
      hashes: [],
      aiAnalysis: {},
      imageTextSimilarity: 0.05,
    });

    expect(result.factors.some((f) => /does not match its title/.test(f))).toBe(false);
    expect(result.riskScore).toBe(0);
  });
});
