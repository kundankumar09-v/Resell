/**
 * Duplicate detection via Hamming distance — unit + integration tests.
 *
 * Covers:
 *  1. hammingDistance() correctness with known test vectors
 *  2. Similarity-based duplicate detection flags near-duplicates (distance ≤ 4)
 *  3. Genuinely different images are NOT falsely flagged
 *  4. Threshold boundary: distance=4 vs distance=5
 *  5. Regression: exact-match (distance=0) still works
 *  6. Integration: detectRisk flags similar hashes in same category
 *  7. SCRUM-32: non-pHash entries (sha256 fallback slices) are skipped,
 *     never crash a probe, and never produce a hamming distance
 */

const mongoose = require('mongoose');
const { server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { hammingDistance, similarity } = require('../services/imageHash');
const { detectRisk } = require('../services/fraudDetection');

describe('Duplicate Detection (Hamming distance)', () => {
  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // ─── 1. hammingDistance() correctness ───

  describe('hammingDistance()', () => {
    it.each([
      ['0000000000000000', '0000000000000000', 0, 'identical hashes'],
      ['0000000000000000', 'ffffffffffffffff', 64, 'opposite bits (max distance)'],
      ['0000000000000000', '0000000000000001', 1, 'one bit different (LSB)'],
      ['0000000000000000', '8000000000000000', 1, 'one bit different (MSB)'],
      ['0000000000000000', '000000000000000f', 4, 'four bits different'],
      ['0000000000000000', '00000000000000ff', 8, 'eight bits different'],
      ['aaaaaaaaaaaaaaaa', '5555555555555555', 64, 'all bits flipped (alternating patterns)'],
      ['0000000000000000', null, 64, 'null second hash (edge case)'],
      ['', '0000000000000000', 64, 'empty first hash (edge case)'],
      ['0000000000000000', '0000000000000000', 0, 'both empty-ish zeros'],
    ])(
      'hammingDistance("%s", "%s") === %d (%s)',
      (h1, h2, expected) => {
        expect(hammingDistance(h1, h2)).toBe(expected);
      }
    );
  });

  describe('similarity()', () => {
    it('returns 1.0 for identical hashes', () => {
      expect(similarity('0000000000000000', '0000000000000000')).toBe(1);
    });

    it('returns 0.0 for opposite hashes', () => {
      expect(similarity('0000000000000000', 'ffffffffffffffff')).toBe(0);
    });

    it('returns ~0.9375 for distance=4 (4/64 = 6.25% different)', () => {
      const sim = similarity('0000000000000000', '000000000000000f');
      expect(sim).toBeCloseTo(0.9375, 3);
    });

    it('returns ~0.921875 for distance=5', () => {
      const sim = similarity('0000000000000000', '000000000000001f');
      expect(sim).toBeCloseTo(0.921875, 3);
    });
  });

  // ─── 7. Non-pHash entries are excluded from hamming math (SCRUM-32) ───

  describe('non-pHash entries (SCRUM-32)', () => {
    // sha256 fallback slice: 64 hex chars, written when sharp is
    // unavailable. Stored in the flat hash list for future exact-match
    // use — but hamming distance over it is meaningless and must be
    // reported as null (probe sites skip it).
    const sha256Entry = 'a'.repeat(64);
    const validPHash = '0000000000000000';

    it('returns null for a sha256 fallback entry vs a valid pHash', () => {
      expect(hammingDistance(validPHash, sha256Entry)).toBeNull();
      expect(hammingDistance(sha256Entry, validPHash)).toBeNull();
    });

    it('returns null when both operands are non-pHash (same 64-char length)', () => {
      expect(hammingDistance(sha256Entry, 'b'.repeat(64))).toBeNull();
    });

    it('similarity() treats a non-pHash pair as never similar (0.0)', () => {
      expect(similarity(validPHash, sha256Entry)).toBe(0);
      expect(similarity(sha256Entry, sha256Entry)).toBe(0);
    });

    it('a stored sha256 entry does not crash the duplicate probe and is skipped', () => {
      // Simulates the probe loop in uploadImages/updateProduct/detectRisk:
      // a candidate's imageHashes mixes pHash and sha256 fallback entries.
      const candidateHashes = [sha256Entry, '000000000000000f', validPHash];
      const flagged = [];
      for (const candidateHash of candidateHashes) {
        const distance = hammingDistance(validPHash, candidateHash);
        if (distance !== null && distance <= 12) {
          flagged.push(candidateHash);
        }
      }
      // Only genuine pHash comparisons produced a verdict — the sha256
      // entry was skipped without crashing (null would have matched
      // under a bare `distance <= threshold` check).
      expect(flagged).toEqual(['000000000000000f', '0000000000000000']);
    });

    it('still compares two valid pHashes normally', () => {
      expect(hammingDistance(validPHash, '000000000000000f')).toBe(4);
      expect(hammingDistance(validPHash, 'ffffffffffffffff')).toBe(64);
    });
  });

  // ─── 2. Threshold boundary: distance=12 vs distance=13 ───

  describe('Threshold boundary (HASH_SIMILARITY_THRESHOLD = 12)', () => {
    const THRESHOLD = 12;

    it('distance=0 (identical) is within threshold', () => {
      expect(hammingDistance('0000000000000000', '0000000000000000')).toBeLessThanOrEqual(THRESHOLD);
    });

    it('distance=11 is within threshold', () => {
      const h1 = '0000000000000000';
      const h2 = '00000000000007ff'; // 11 bits set
      expect(hammingDistance(h1, h2)).toBe(11);
      expect(hammingDistance(h1, h2)).toBeLessThanOrEqual(THRESHOLD);
    });

    it('distance=12 is within threshold (boundary)', () => {
      const h1 = '0000000000000000';
      const h2 = '0000000000000fff'; // 12 bits set
      expect(hammingDistance(h1, h2)).toBe(12);
      expect(hammingDistance(h1, h2)).toBeLessThanOrEqual(THRESHOLD);
    });

    it('distance=13 is OUTSIDE threshold (boundary)', () => {
      const h1 = '0000000000000000';
      const h2 = '0000000000001fff'; // 13 bits set
      expect(hammingDistance(h1, h2)).toBe(13);
      expect(hammingDistance(h1, h2)).toBeGreaterThan(THRESHOLD);
    });

    it('distance=14 is outside threshold', () => {
      const h1 = '0000000000000000';
      const h2 = '0000000000003fff'; // 14 bits set
      expect(hammingDistance(h1, h2)).toBe(14);
      expect(hammingDistance(h1, h2)).toBeGreaterThan(THRESHOLD);
    });
  });

  // ─── 3. Regression: exact-match (distance=0) still flagged ───

  describe('Regression: exact-match detection still works', () => {
    let seller, category;

    beforeEach(async () => {
      seller = await User.create({
        name: 'Dup Test Seller',
        email: `dup-${Date.now()}@example.com`,
        password: 'password123',
        role: 'seller',
        createdAt: new Date(Date.now() - 365 * 86400000),
      });
      category = await Category.create({
        name: 'Dup Category',
        slug: `dup-cat-${Date.now()}`,
        icon: 'box',
      });
    });

    it('flags product with identical hash (distance=0)', async () => {
      // Create reference product
      await Product.create({
        title: 'Reference Product',
        description: 'Reference description for dup test',
        price: 100,
        category: category._id,
        images: [{ url: 'http://x.com/ref.jpg', publicId: 'ref' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['aaaaaaaaaaaaaaaa'] },
      });

      // Create product with same hash
      const product = await Product.create({
        title: 'Duplicate Product',
        description: 'Duplicate description for dup test',
        price: 80,
        category: category._id,
        images: [{ url: 'http://x.com/dup.jpg', publicId: 'dup' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['aaaaaaaaaaaaaaaa'] },
      });

      const result = await detectRisk({
        product,
        hashes: ['aaaaaaaaaaaaaaaa'],
        aiAnalysis: { damageScore: 10 },
      });

      expect(result.riskScore).toBeGreaterThanOrEqual(35);
      expect(result.factors.some((f) => f.includes('Duplicate image'))).toBe(true);
    });
  });

  // ─── 4. Near-duplicate (distance ≤ 4) IS flagged ───

  describe('Near-duplicate detection (distance ≤ threshold)', () => {
    let seller, category;

    beforeEach(async () => {
      seller = await User.create({
        name: 'NearDup Seller',
        email: `neardup-${Date.now()}@example.com`,
        password: 'password123',
        role: 'seller',
        createdAt: new Date(Date.now() - 365 * 86400000),
      });
      category = await Category.create({
        name: 'NearDup Category',
        slug: `neardup-cat-${Date.now()}`,
        icon: 'box',
      });
    });

    it('flags product with hash distance=2 (slightly edited image)', async () => {
      await Product.create({
        title: 'Original NearDup',
        description: 'Original for neardup test',
        price: 200,
        category: category._id,
        images: [{ url: 'http://x.com/orig.jpg', publicId: 'orig' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['0000000000000000'] },
      });

      // Hash with 2 bits different (simulates crop/recompress)
      const product = await Product.create({
        title: 'Edited Version',
        description: 'Edited for neardup test',
        price: 190,
        category: category._id,
        images: [{ url: 'http://x.com/edited.jpg', publicId: 'edited' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['0000000000000003'] }, // distance=2 from original
      });

      const result = await detectRisk({
        product,
        hashes: ['0000000000000003'],
        aiAnalysis: { damageScore: 10 },
      });

      expect(result.riskScore).toBeGreaterThanOrEqual(35);
      expect(result.factors.some((f) => f.includes('Duplicate image'))).toBe(true);
    });

    it('flags product with hash distance=12 (at threshold boundary)', async () => {
      await Product.create({
        title: 'Original Boundary',
        description: 'Original boundary test',
        price: 300,
        category: category._id,
        images: [{ url: 'http://x.com/bound1.jpg', publicId: 'bound1' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['0000000000000000'] },
      });

      const product = await Product.create({
        title: 'Boundary Match',
        description: 'Boundary match test',
        price: 280,
        category: category._id,
        images: [{ url: 'http://x.com/bound2.jpg', publicId: 'bound2' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['0000000000000fff'] }, // distance=12
      });

      const result = await detectRisk({
        product,
        hashes: ['0000000000000fff'],
        aiAnalysis: { damageScore: 10 },
      });

      expect(result.riskScore).toBeGreaterThanOrEqual(35);
    });
  });

  // ─── 5. Different image NOT falsely flagged ───

  describe('Different images are NOT falsely flagged', () => {
    let seller, category;

    beforeEach(async () => {
      seller = await User.create({
        name: 'FalsePositive Seller',
        email: `fp-${Date.now()}@example.com`,
        password: 'password123',
        role: 'seller',
        createdAt: new Date(Date.now() - 365 * 86400000),
      });
      category = await Category.create({
        name: 'FalsePositive Category',
        slug: `fp-cat-${Date.now()}`,
        icon: 'box',
      });
    });

    it('does NOT flag when hamming distance > threshold (distance=13)', async () => {
      await Product.create({
        title: 'White T-Shirt A',
        description: 'White cotton tee',
        price: 25,
        category: category._id,
        images: [{ url: 'http://x.com/tshirt-a.jpg', publicId: 'ts-a' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['0000000000000000'] },
      });

      // Different image hash (distance=13 from first product, above threshold of 12)
      const product = await Product.create({
        title: 'White T-Shirt B',
        description: 'Different white cotton tee',
        price: 30,
        category: category._id,
        images: [{ url: 'http://x.com/tshirt-b.jpg', publicId: 'ts-b' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['0000000000001fff'] }, // distance=13
      });

      const result = await detectRisk({
        product,
        hashes: ['0000000000001fff'],
        aiAnalysis: { damageScore: 10 },
      });

      // Should NOT be flagged as duplicate
      expect(result.factors.some((f) => f.includes('Duplicate image'))).toBe(false);
      // Risk score from other factors should be low (just the damage score bonus if any)
      expect(result.riskScore).toBeLessThan(35);
    });

    it('does NOT flag when hash distance=64 (opposite hashes)', async () => {
      await Product.create({
        title: 'Item Alpha',
        description: 'Alpha description for fp test',
        price: 50,
        category: category._id,
        images: [{ url: 'http://x.com/alpha.jpg', publicId: 'alpha' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['0000000000000000'] },
      });

      const product = await Product.create({
        title: 'Item Omega',
        description: 'Omega description for fp test',
        price: 55,
        category: category._id,
        images: [{ url: 'http://x.com/omega.jpg', publicId: 'omega' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['ffffffffffffffff'] }, // distance=64
      });

      const result = await detectRisk({
        product,
        hashes: ['ffffffffffffffff'],
        aiAnalysis: { damageScore: 10 },
      });

      expect(result.factors.some((f) => f.includes('Duplicate image'))).toBe(false);
    });

    it('does NOT cross-category match (different category not checked)', async () => {
      const catA = await Category.create({
        name: 'Category A',
        slug: `cat-a-${Date.now()}`,
        icon: 'box',
      });
      const catB = await Category.create({
        name: 'Category B',
        slug: `cat-b-${Date.now()}`,
        icon: 'box',
      });

      await Product.create({
        title: 'Electronics Item',
        description: 'Electronics for cross-cat test',
        price: 100,
        category: catA._id,
        images: [{ url: 'http://x.com/electronics.jpg', publicId: 'elec' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['aaaaaaaaaaaaaaaa'] },
      });

      // Same hash but different category
      const product = await Product.create({
        title: 'Fashion Item',
        description: 'Fashion for cross-cat test',
        price: 50,
        category: catB._id,
        images: [{ url: 'http://x.com/fashion.jpg', publicId: 'fash' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['aaaaaaaaaaaaaaaa'] },
      });

      const result = await detectRisk({
        product,
        hashes: ['aaaaaaaaaaaaaaaa'],
        aiAnalysis: { damageScore: 10 },
      });

      // Should not flag as duplicate since candidates are filtered by category
      expect(result.factors.some((f) => f.includes('Duplicate image'))).toBe(false);
    });
  });
});
