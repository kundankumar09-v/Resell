/**
 * Category-agreement signal + cross-category pHash routing — unit + integration.
 *
 * After MobileNet classification the worker compares the predicted category to
 * the seller's chosen category. A disagreement is supporting-only (+10,
 * category content_mismatch) and only fires when the classifier is confident
 * (>= 0.5). When it fires, the pHash duplicate scan is widened to the suggested
 * category's listings so a repost filed under the "wrong" category cannot
 * dodge the same-category gate.
 */

const mongoose = require('mongoose');
const { server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const {
  detectRisk,
  assessCategoryAgreement,
  CATEGORY_MISMATCH_SIGNAL,
} = require('../services/fraudDetection');

describe('Category-agreement signal', () => {
  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // ── Pure agreement assessment (no DB) ──────────────────────────────────────

  describe('assessCategoryAgreement', () => {
    it('agreement -> no mismatch', () => {
      const r = assessCategoryAgreement({
        predictedCategory: 'Mobile Phones',
        confidence: 0.9,
        chosenCategoryName: 'Mobile Phones',
      });
      expect(r.mismatch).toBe(false);
      expect(r.reason).toBe('agreement');
    });

    it('confident disagreement -> mismatch', () => {
      const r = assessCategoryAgreement({
        predictedCategory: 'Mobile Phones',
        confidence: 0.82,
        chosenCategoryName: 'Fashion',
      });
      expect(r.mismatch).toBe(true);
      expect(r.reason).toBe('mismatch');
    });

    it('low confidence never fires, even on a disagreement', () => {
      const r = assessCategoryAgreement({
        predictedCategory: 'Mobile Phones',
        confidence: 0.3,
        chosenCategoryName: 'Fashion',
      });
      expect(r.mismatch).toBe(false);
      expect(r.reason).toBe('low_confidence');
    });

    it('a missing / "Other" prediction never fires', () => {
      expect(
        assessCategoryAgreement({ predictedCategory: 'Other', confidence: 0.9, chosenCategoryName: 'Fashion' })
          .mismatch
      ).toBe(false);
      expect(
        assessCategoryAgreement({ predictedCategory: '', confidence: 0.9, chosenCategoryName: 'Fashion' })
          .mismatch
      ).toBe(false);
    });
  });

  // ── detectRisk integration (DB-backed) ─────────────────────────────────────

  const makeSeller = () =>
    User.create({
      name: 'Seller',
      email: `cat-${Date.now()}-${Math.random()}@test.com`,
      password: 'pass123',
      role: 'seller',
      createdAt: new Date(Date.now() - 365 * 86400000),
    });

  const makeCategory = (slug) => Category.create({ name: slug, slug, icon: 'phone' });

  const makeProduct = ({ seller, category, title = 'Listing', hash }) =>
    Product.create({
      title,
      description: 'A perfectly ordinary, unique description for this listing.',
      price: 100,
      category: category._id,
      images: [{ url: 'http://x.com/1.jpg', publicId: 'x1' }],
      seller: seller._id,
      status: 'active',
      aiAnalysis: hash ? { imageHashes: [hash] } : undefined,
    });

  it('confident disagreement -> +10 with the content_mismatch category', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('cat-mismatch');
    const product = await makeProduct({ seller, category });

    const result = await detectRisk({
      product,
      hashes: [],
      aiAnalysis: {},
      categoryMismatch: true,
    });

    expect(result.factors.some((f) => /category/i.test(f))).toBe(true);
    expect(result.riskFactorCategories).toContain('content_mismatch');
    expect(result.riskScore).toBeGreaterThanOrEqual(10);
  });

  it('agreement -> no category signal', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('cat-agree');
    const product = await makeProduct({ seller, category });

    const result = await detectRisk({ product, hashes: [], aiAnalysis: {}, categoryMismatch: false });

    expect(result.factors.some((f) => /category/i.test(f))).toBe(false);
    expect(result.riskScore).toBe(0);
  });

  it('widens the pHash scan to the suggested category (additionalScanCategories)', async () => {
    const seller = await makeSeller();
    const otherSeller = await makeSeller();
    const chosenCategory = await makeCategory('cat-chosen');
    const suggestedCategory = await makeCategory('cat-suggested');

    const HASH = 'aaaaaaaaaaaaaaaa';
    // The same image already lives in the SUGGESTED category under another seller.
    await makeProduct({
      seller: otherSeller,
      category: suggestedCategory,
      title: 'Reference in suggested category',
      hash: HASH,
    });
    const probe = await makeProduct({ seller, category: chosenCategory, title: 'Probe', hash: HASH });

    // Without the widened scan, the different-category duplicate is invisible.
    const without = await detectRisk({ product: probe, hashes: [HASH], aiAnalysis: { imageHashes: [HASH] } });
    expect(without.factors.some((f) => /Duplicate image detected/.test(f))).toBe(false);

    // With the suggested category added, the pHash gate fires.
    const withScan = await detectRisk({
      product: probe,
      hashes: [HASH],
      aiAnalysis: { imageHashes: [HASH] },
      additionalScanCategories: [suggestedCategory._id],
    });
    expect(withScan.factors.some((f) => /Duplicate image detected/.test(f))).toBe(true);
    expect(withScan.riskScore).toBeGreaterThanOrEqual(35);
  });

  it('exports the CATEGORY_MISMATCH signal name', () => {
    expect(CATEGORY_MISMATCH_SIGNAL).toBe('CATEGORY_MISMATCH');
  });
});
