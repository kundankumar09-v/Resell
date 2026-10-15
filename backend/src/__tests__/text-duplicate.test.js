/**
 * Near-duplicate description detection — integration tests (DB-backed).
 *
 * Covers the two-tier design in fraudDetection.detectRisk():
 *  1. exact-match fast path (identical description) short-circuits similarity;
 *  2. similarity scan catches lightly-edited descriptions, +20 for the same
 *     seller and +15 across sellers in the same category.
 *
 * The ML service is assumed unreachable in tests, so similarity falls back to
 * the pure-JS character 3-gram Jaccard score (threshold 0.85). The pairs below
 * are chosen to clear that threshold lexically, so the result is stable even if
 * a local ML service happens to be running.
 */

const mongoose = require('mongoose');
const { server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { detectRisk } = require('../services/fraudDetection');

describe('Near-duplicate description detection', () => {
  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  const makeSeller = (name, email) =>
    User.create({
      name,
      email,
      password: 'pass123',
      role: 'seller',
      createdAt: new Date(Date.now() - 365 * 86400000), // avoid new-account signal
    });

  const makeCategory = (slug) =>
    Category.create({ name: slug, slug, icon: 'phone' });

  const makeProduct = ({ seller, category, description, title = 'Listing', price = 100, status = 'active' }) =>
    Product.create({
      title,
      description,
      price,
      category: category._id,
      images: [{ url: 'http://x.com/1.jpg', publicId: 'x1' }],
      seller: seller._id,
      status,
    });

  it('flags an identical description via the exact-match fast path', async () => {
    const seller = await makeSeller('Seller A', 'a@test.com');
    const category = await makeCategory('dup-exact');

    await makeProduct({ seller, category, description: 'iPhone 13 128GB midnight blue, great condition' });
    const second = await makeProduct({
      seller,
      category,
      description: 'iPhone 13 128GB midnight blue, great condition',
    });

    const result = await detectRisk({ product: second, hashes: [], aiAnalysis: {} });

    expect(result.factors.some((f) => /Same description used in 2 active listings/.test(f))).toBe(true);
    expect(result.factors.some((f) => /CROSS_LISTING_TEXT_DUPLICATE/.test(f))).toBe(false);
    expect(result.riskScore).toBeGreaterThanOrEqual(20);
  });

  it('catches a lightly-edited description from the same seller (similarity path)', async () => {
    const seller = await makeSeller('Seller B', 'b@test.com');
    const category = await makeCategory('dup-same-seller');

    await makeProduct({
      seller,
      category,
      title: 'iPhone 13 listing',
      description: 'iPhone 13 128GB midnight blue, great condition, no scratches',
    });
    const edited = await makeProduct({
      seller,
      category,
      title: 'iPhone 13 listing',
      description: 'iPhone 13 128GB midnight blue, great condition, no scratches at all',
    });

    const result = await detectRisk({ product: edited, hashes: [], aiAnalysis: {} });

    expect(result.factors.some((f) => /CROSS_LISTING_TEXT_DUPLICATE/.test(f))).toBe(true);
    // Same seller -> +20 (matching the exact-match weight); no image signals.
    expect(result.riskScore).toBeGreaterThanOrEqual(20);
  });

  it('flags a near-duplicate description across sellers in the same category (+15)', async () => {
    const sellerA = await makeSeller('Seller C', 'c@test.com');
    const sellerB = await makeSeller('Seller D', 'd@test.com');
    const category = await makeCategory('dup-cross-seller');

    await makeProduct({
      seller: sellerA,
      category,
      title: 'Reference',
      description: 'Vintage leather jacket, brown, size L, worn twice',
    });
    const other = await makeProduct({
      seller: sellerB,
      category,
      title: 'Suspicious copy',
      description: 'Vintage leather jacket, brown, size L, worn twice only',
    });

    const result = await detectRisk({ product: other, hashes: [], aiAnalysis: {} });

    expect(result.factors.some((f) => /CROSS_LISTING_TEXT_DUPLICATE/.test(f))).toBe(true);
    expect(result.riskScore).toBeGreaterThanOrEqual(15);
    // Cross-seller signal is lighter than the same-seller one.
    expect(result.riskScore).toBeLessThan(35);
  });

  it('does not flag genuinely different descriptions', async () => {
    const seller = await makeSeller('Seller E', 'e@test.com');
    const category = await makeCategory('dup-clean');

    await makeProduct({
      seller,
      category,
      title: 'Keyboard',
      description: 'Mechanical keyboard with blue switches, lightly used',
    });
    const clean = await makeProduct({
      seller,
      category,
      title: 'Desk lamp',
      description: 'Adjustable LED desk lamp, warm and cool light modes',
    });

    const result = await detectRisk({ product: clean, hashes: [], aiAnalysis: {} });

    expect(result.factors.some((f) => /Same description used|CROSS_LISTING_TEXT_DUPLICATE/.test(f))).toBe(false);
  });

  it('does not scan across categories for the cross-seller signal', async () => {
    const sellerA = await makeSeller('Seller F', 'f@test.com');
    const sellerB = await makeSeller('Seller G', 'g@test.com');
    const categoryA = await makeCategory('dup-cat-a');
    const categoryB = await makeCategory('dup-cat-b');

    await makeProduct({
      seller: sellerA,
      category: categoryA,
      title: 'Reference',
      description: 'New Balance 550 white green US 10, worn twice',
    });
    const other = await makeProduct({
      seller: sellerB,
      category: categoryB,
      title: 'Different category',
      description: 'New Balance 550 white green US 10, worn twice total',
    });

    const result = await detectRisk({ product: other, hashes: [], aiAnalysis: {} });

    expect(result.factors.some((f) => /CROSS_LISTING_TEXT_DUPLICATE/.test(f))).toBe(false);
  });

  it('ignores sold listings (a legitimate relist is not a duplicate)', async () => {
    const seller = await makeSeller('Seller H', 'h@test.com');
    const category = await makeCategory('dup-sold');

    await makeProduct({
      seller,
      category,
      title: 'Old listing',
      description: 'Office chair, ergonomic, mesh back, very comfortable',
      status: 'sold',
    });
    const relist = await makeProduct({
      seller,
      category,
      title: 'Relisted',
      description: 'Office chair, ergonomic, mesh back, very comfortable indeed',
    });

    const result = await detectRisk({ product: relist, hashes: [], aiAnalysis: {} });

    expect(result.factors.some((f) => /Same description used|CROSS_LISTING_TEXT_DUPLICATE/.test(f))).toBe(false);
  });

  it('exposes the generalized content category for text-scam factors', async () => {
    const seller = await makeSeller('Seller I', 'i@test.com');
    const category = await makeCategory('scam-category');

    const scam = await makeProduct({
      seller,
      category,
      title: 'URGENT SALE',
      description: 'need cash today!!! CALL 9876543210',
    });

    const result = await detectRisk({ product: scam, hashes: [], aiAnalysis: {} });

    expect(result.riskFactorCategories).toContain('content_scam_signals');
    expect(result.riskScore).toBeGreaterThanOrEqual(25);
  });
});
