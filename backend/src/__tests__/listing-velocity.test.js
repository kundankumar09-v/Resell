/**
 * Listing-velocity (burst) signal — integration tests.
 *
 * detectRisk counts the seller's OTHER active-window listings created in the
 * last 24h with a single indexed query. Two thresholds, never stacked:
 *   - >= 5 in 24h from an account < 7 days old -> LISTING_BURST_NEW_ACCOUNT (+15)
 *   - >= 10 in 24h from any account             -> LISTING_BURST (+10)
 * When both would apply the larger (+15) fires alone.
 */

const mongoose = require('mongoose');
const { server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { detectRisk, LISTING_BURST_SIGNAL, LISTING_BURST_NEW_ACCOUNT_SIGNAL } = require('../services/fraudDetection');

describe('Listing-velocity (burst) signal', () => {
  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  const makeSeller = (daysOld) =>
    User.create({
      name: 'Seller',
      email: `vel-${Date.now()}-${Math.random()}@test.com`,
      password: 'pass123',
      role: 'seller',
      createdAt: new Date(Date.now() - daysOld * 86400000),
    });

  const makeCategory = (slug) => Category.create({ name: slug, slug, icon: 'phone' });

  const makeProduct = ({ seller, category, title, description, createdAt }) =>
    Product.create({
      title,
      description,
      price: 100,
      originalPrice: 0,
      category: category._id,
      images: [{ url: 'http://x.com/1.jpg', publicId: 'x1' }],
      seller: seller._id,
      status: 'active',
      ...(createdAt ? { createdAt } : {}),
    });

  /** Create `n` recent filler listings for the seller (distinct from the target). */
  const makeFillers = async (seller, category, n) => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    for (let i = 0; i < n; i++) {
      await makeProduct({
        seller,
        category,
        title: `Filler listing ${i + 1}`,
        description: `Filler item number ${i + 1} — miscellaneous household goods in working order, no defects.`,
        createdAt: recent,
      });
    }
  };

  const makeTarget = (seller, category) =>
    makeProduct({
      seller,
      category,
      title: 'Target velocity listing',
      description:
        'A completely distinct target sentence used only for the velocity assessment, with vocabulary unlike the fillers.',
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    });

  it('4 listings from a new account -> clean (below threshold)', async () => {
    const seller = await makeSeller(2);
    const category = await makeCategory('vel-four-new');
    await makeFillers(seller, category, 4);
    const target = await makeTarget(seller, category);

    const result = await detectRisk({ product: target, hashes: [], aiAnalysis: {} });

    expect(result.factors.some((f) => /burst/i.test(f))).toBe(false);
    expect(result.riskScore).toBe(0);
  });

  it('6 listings from a new account -> +15 LISTING_BURST_NEW_ACCOUNT', async () => {
    const seller = await makeSeller(2);
    const category = await makeCategory('vel-six-new');
    await makeFillers(seller, category, 6);
    const target = await makeTarget(seller, category);

    const result = await detectRisk({ product: target, hashes: [], aiAnalysis: {} });

    expect(result.riskScore).toBe(15);
    expect(result.factors.some((f) => /burst/i.test(f))).toBe(true);
    expect(result.riskFactorCategories).toContain('account_risk');
    expect(LISTING_BURST_NEW_ACCOUNT_SIGNAL).toBe('LISTING_BURST_NEW_ACCOUNT');
  });

  it('12 listings from an old account -> +10 LISTING_BURST', async () => {
    const seller = await makeSeller(365);
    const category = await makeCategory('vel-twelve-old');
    await makeFillers(seller, category, 12);
    const target = await makeTarget(seller, category);

    const result = await detectRisk({ product: target, hashes: [], aiAnalysis: {} });

    expect(result.riskScore).toBe(10);
    expect(result.factors.some((f) => /burst/i.test(f))).toBe(true);
    expect(result.riskFactorCategories).toContain('account_risk');
    expect(LISTING_BURST_SIGNAL).toBe('LISTING_BURST');
  });

  it('12 listings from a new account -> only the larger (+15) fires', async () => {
    const seller = await makeSeller(2);
    const category = await makeCategory('vel-twelve-new');
    await makeFillers(seller, category, 12);
    const target = await makeTarget(seller, category);

    const result = await detectRisk({ product: target, hashes: [], aiAnalysis: {} });

    // Not stacked: 15, never 25.
    expect(result.riskScore).toBe(15);
  });

  it('5 listings from an old account -> no velocity signal (age gate)', async () => {
    const seller = await makeSeller(365);
    const category = await makeCategory('vel-five-old');
    await makeFillers(seller, category, 5);
    const target = await makeTarget(seller, category);

    const result = await detectRisk({ product: target, hashes: [], aiAnalysis: {} });

    expect(result.riskScore).toBe(0);
  });
});
