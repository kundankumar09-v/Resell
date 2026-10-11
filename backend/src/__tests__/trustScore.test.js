// Unit tests for the seller trust score calculation (trustScore.js).
// Verifies the 0-max clamping of every component and exact computed outputs.

const mongoose = require('mongoose');
const { server } = require('../server');
const User = require('../models/User');
const Review = require('../models/Review');
const Sale = require('../models/Sale');
const Report = require('../models/Report');

const { calculateTrustScore } = require('../services/trustScore');

describe('trustScore.calculateTrustScore', () => {
  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  it('returns score 0 and level unknown for non-existent user', async () => {
    const result = await calculateTrustScore(new mongoose.Types.ObjectId());
    expect(result.score).toBe(0);
    expect(result.level).toBe('unknown');
  });

  it('new seller (0 sales, no rating) computes the exact default breakdown', async () => {
    const user = await User.create({
      name: 'New Seller',
      email: 'new-seller@test.com',
      password: 'password123',
      role: 'seller',
    });

    const result = await calculateTrustScore(user._id);

    // age: 0 days -> 0; sales: log10(1)*10 = 0; rating: default 3.5 -> 17.5;
    // response: default 60 min -> 15 - 5 = 10; complaints: (1 - 0/20)*15 = 15;
    // listingQuality: 0 listings -> 0. Total = 42.5 -> rounded 43.
    expect(result.breakdown.accountAge.score).toBe(0);
    expect(result.breakdown.accountAge.days).toBe(0);
    expect(result.breakdown.sales.score).toBe(0);
    expect(result.breakdown.sales.count).toBe(0);
    expect(result.breakdown.rating.score).toBe(18); // Math.round(17.5)
    expect(result.breakdown.rating.average).toBe(3.5);
    expect(result.breakdown.rating.count).toBe(0);
    expect(result.breakdown.responseTime.score).toBe(10);
    expect(result.breakdown.complaints.score).toBe(15);
    expect(result.breakdown.listingQuality.score).toBe(0);
    expect(result.score).toBe(43);
    expect(result.level).toBe('developing');
  });

  it('seller with 47 sales / 4.4 rating / 30 min response / 1 complaint computes exact output', async () => {
    const user = await User.create({
      name: 'Active Seller',
      email: 'active-seller@test.com',
      password: 'password123',
      role: 'seller',
      averageResponseMinutes: 30,
    });
    await Sale.create({
      product: new mongoose.Types.ObjectId(),
      seller: user._id,
      buyer: new mongoose.Types.ObjectId(),
      salePrice: 100,
      netAmount: 100,
    });
    // 47 sales total: 46 more copies with different buyers.
    for (let i = 0; i < 46; i++) {
      await Sale.create({
        product: new mongoose.Types.ObjectId(),
        seller: user._id,
        buyer: new mongoose.Types.ObjectId(),
        salePrice: 100,
        netAmount: 100,
      });
    }
    // 4.4 average rating: 4 ratings of 5 and one of 2 -> (5*4 + 2)/5 = 4.4
    for (let i = 0; i < 4; i++) {
      await Review.create({
        seller: user._id,
        buyer: new mongoose.Types.ObjectId(),
        rating: 5,
      });
    }
    await Review.create({
      seller: user._id,
      buyer: new mongoose.Types.ObjectId(),
      rating: 2,
    });
    await Report.create({
      target: user._id,
      targetType: 'user',
      reporter: new mongoose.Types.ObjectId(),
      reason: 'other',
    });

    const result = await calculateTrustScore(user._id);

    // sales: log10(48)*10 = 16.81 -> 17; rating: (4.4/5)*25 = 22;
    // response: 15 - (30/60)*5 = 12.5 -> 13; complaints: (1 - 1/20)*15 = 14.25 -> 14;
    // age: 0 days -> 0; listingQuality: no listings -> 0.
    // Total = 16.81 + 22 + 12.5 + 14.25 = 65.56 -> rounded 66.
    expect(result.breakdown.sales.score).toBe(17);
    expect(result.breakdown.sales.count).toBe(47);
    expect(result.breakdown.rating.score).toBe(22);
    expect(result.breakdown.rating.average).toBe(4.4);
    expect(result.breakdown.responseTime.score).toBe(13);
    expect(result.breakdown.complaints.score).toBe(14);
    expect(result.breakdown.complaints.complaints).toBe(1);
    expect(result.breakdown.listingQuality.score).toBe(0);
    expect(result.score).toBe(66);
    expect(result.level).toBe('trusted');
  });

  it('300-minute response time never produces a negative component score', async () => {
    const user = await User.create({
      name: 'Slow Responder',
      email: 'slow-responder@test.com',
      password: 'password123',
      role: 'seller',
      averageResponseMinutes: 300,
    });

    const result = await calculateTrustScore(user._id);

    // Raw formula: 15 - (300/60)*5 = -10 -> clamped to 0.
    expect(result.breakdown.responseTime.score).toBe(0);
    expect(result.breakdown.responseTime.score).toBeGreaterThanOrEqual(0);
  });

  it('clamps every component between 0 and its max', async () => {
    const user = await User.create({
      name: 'Extreme Seller',
      email: 'extreme-seller@test.com',
      password: 'password123',
      role: 'seller',
      averageResponseMinutes: 300,
      complaints: 500,
    });

    const result = await calculateTrustScore(user._id);

    const b = result.breakdown;
    expect(b.accountAge.score).toBeGreaterThanOrEqual(0);
    expect(b.accountAge.score).toBeLessThanOrEqual(15);
    expect(b.sales.score).toBeGreaterThanOrEqual(0);
    expect(b.sales.score).toBeLessThanOrEqual(20);
    expect(b.rating.score).toBeGreaterThanOrEqual(0);
    expect(b.rating.score).toBeLessThanOrEqual(25);
    expect(b.responseTime.score).toBeGreaterThanOrEqual(0);
    expect(b.responseTime.score).toBeLessThanOrEqual(15);
    expect(b.complaints.score).toBeGreaterThanOrEqual(0); // floor, not negative
    expect(b.complaints.score).toBeLessThanOrEqual(15);
    expect(b.listingQuality.score).toBeGreaterThanOrEqual(0);
    expect(b.listingQuality.score).toBeLessThanOrEqual(10);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('caps the sales component when recent sales are concentrated in repeat buyers', async () => {
    const user = await User.create({
      name: 'Concentrated Seller',
      email: 'concentrated-seller@test.com',
      password: 'password123',
      role: 'seller',
    });
    const confederate = new mongoose.Types.ObjectId();
    // 20 recent sales, every single one to the same repeat buyer.
    for (let i = 0; i < 20; i++) {
      await Sale.create({
        product: new mongoose.Types.ObjectId(),
        seller: user._id,
        buyer: confederate,
        salePrice: 100,
        netAmount: 100,
      });
    }

    const result = await calculateTrustScore(user._id);

    // ratio = 1 - 1/20 = 0.95 > 0.6 -> cap sales at 50% of max (10 points).
    expect(result.breakdown.sales.count).toBe(20);
    expect(result.breakdown.sales.concentrationRatio).toBe(0.95);
    expect(result.breakdown.sales.capped).toBe(true);
    expect(result.breakdown.sales.score).toBe(10);
    // Un-capped it would be log10(21)*10 ≈ 13.  Capped: still 10.
    expect(result.score).toBeLessThan(70); // sales contribution no longer inflated
  });

  it('does not cap sales when recent buyers are distinct', async () => {
    const user = await User.create({
      name: 'Distinct Seller',
      email: 'distinct-seller@test.com',
      password: 'password123',
      role: 'seller',
    });
    for (let i = 0; i < 20; i++) {
      await Sale.create({
        product: new mongoose.Types.ObjectId(),
        seller: user._id,
        buyer: new mongoose.Types.ObjectId(),
        salePrice: 100,
        netAmount: 100,
      });
    }

    const result = await calculateTrustScore(user._id);

    expect(result.breakdown.sales.count).toBe(20);
    expect(result.breakdown.sales.concentrationRatio).toBe(0);
    expect(result.breakdown.sales.capped).toBe(false);
    expect(result.breakdown.sales.score).toBe(13); // log10(21)*10 ≈ 13.32
  });
});
