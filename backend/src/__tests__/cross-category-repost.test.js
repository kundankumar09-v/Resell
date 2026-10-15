/**
 * Cross-category CLIP image-repost scan — unit + integration tests.
 *
 * When the ML service is reachable and the listing has a CLIP embedding, the
 * worker queries the top-K most similar platform-wide embeddings
 * (vectorSearch.searchVectorNearestNeighbors with crossCategory). A cross-seller
 * hit at/above CROSS_CATEGORY_SIM_THRESHOLD (0.93) where pHash did NOT already
 * fire raises CROSS_CATEGORY_IMAGE_REPOST (+20, possible_duplicate_image).
 * The signal is suppressed whenever the pHash duplicate gate already fired, so
 * it can never exceed the pHash duplicate weight.
 *
 * vectorSearch is mocked here so the assertions do not depend on a live index.
 */

const mongoose = require('mongoose');
const { server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');

jest.mock('../services/vectorSearch', () => {
  const actual = jest.requireActual('../services/vectorSearch');
  return { ...actual, searchVectorNearestNeighbors: jest.fn() };
});

const vectorSearch = require('../services/vectorSearch');
const {
  detectRisk,
  assessCrossCategoryImageRepost,
  CROSS_CATEGORY_IMAGE_REPOST_SIGNAL,
} = require('../services/fraudDetection');

const embedding = () => new Array(512).fill(0).map((_, i) => (i % 7) / 7);

describe('Cross-category CLIP image-repost scan', () => {
  beforeEach(() => {
    vectorSearch.searchVectorNearestNeighbors.mockReset();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // ── assessCrossCategoryImageRepost ─────────────────────────────────────────

  it('fires for a cross-seller hit at/above the threshold and scans cross-category', async () => {
    vectorSearch.searchVectorNearestNeighbors.mockResolvedValue([
      { _id: 'other', seller: 'seller-2', score: 0.95, title: 'Stolen iPhone listing', category: 'c2' },
    ]);

    const result = await assessCrossCategoryImageRepost({
      productId: 'p1',
      embedding: embedding(),
      sellerId: 'seller-1',
    });

    expect(result.available).toBe(true);
    expect(result.signal).toBe(CROSS_CATEGORY_IMAGE_REPOST_SIGNAL);
    expect(result.similarity).toBeCloseTo(0.95, 5);
    expect(vectorSearch.searchVectorNearestNeighbors).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ crossCategory: true })
    );
  });

  it('adds nothing when the best cross-seller hit is below the threshold', async () => {
    vectorSearch.searchVectorNearestNeighbors.mockResolvedValue([
      { _id: 'other', seller: 'seller-2', score: 0.8, title: 'Unrelated', category: 'c2' },
    ]);

    const result = await assessCrossCategoryImageRepost({
      productId: 'p1',
      embedding: embedding(),
      sellerId: 'seller-1',
    });

    expect(result.available).toBe(true);
    expect(result.signal).toBeNull();
  });

  it('ignores a same-seller hit even at a very high similarity', async () => {
    vectorSearch.searchVectorNearestNeighbors.mockResolvedValue([
      { _id: 'own', seller: 'seller-1', score: 0.99, title: 'My own listing', category: 'c2' },
    ]);

    const result = await assessCrossCategoryImageRepost({
      productId: 'p1',
      embedding: embedding(),
      sellerId: 'seller-1',
    });

    expect(result.signal).toBeNull();
  });

  it('skips silently when the listing has no embedding (ML service down)', async () => {
    const result = await assessCrossCategoryImageRepost({
      productId: 'p1',
      embedding: [],
      sellerId: 'seller-1',
    });

    expect(result).toEqual(expect.objectContaining({ available: false, signal: null }));
    expect(vectorSearch.searchVectorNearestNeighbors).not.toHaveBeenCalled();
  });

  // ── detectRisk integration (DB-backed) ─────────────────────────────────────

  const makeSeller = () =>
    User.create({
      name: 'Seller',
      email: `xcat-${Date.now()}-${Math.random()}@test.com`,
      password: 'pass123',
      role: 'seller',
      createdAt: new Date(Date.now() - 365 * 86400000),
    });

  const makeCategory = (slug) => Category.create({ name: slug, slug, icon: 'phone' });

  const makeProduct = ({
    seller,
    category,
    title = 'Listing',
    hash,
    description = 'An ordinary unique description for this listing.',
  }) =>
    Product.create({
      title,
      description,
      price: 100,
      category: category._id,
      images: [{ url: 'http://x.com/1.jpg', publicId: 'x1' }],
      seller: seller._id,
      status: 'active',
      aiAnalysis: hash ? { imageHashes: [hash] } : undefined,
    });

  it('adds +20 under possible_duplicate_image when the signal is present', async () => {
    const seller = await makeSeller();
    const category = await makeCategory('xcat-signal');
    const product = await makeProduct({ seller, category });

    const result = await detectRisk({
      product,
      hashes: [],
      aiAnalysis: {},
      crossCategoryRepost: {
        signal: CROSS_CATEGORY_IMAGE_REPOST_SIGNAL,
        similarity: 0.95,
        similarToTitle: 'Stolen listing in another category',
      },
    });

    expect(result.factors.some((f) => /CROSS_CATEGORY_IMAGE_REPOST/.test(f))).toBe(true);
    expect(result.riskFactorCategories).toContain('possible_duplicate_image');
    expect(result.riskScore).toBeGreaterThanOrEqual(20);
    expect(result.riskScore).toBeLessThan(35);
  });

  it('is suppressed when the pHash duplicate gate already fired', async () => {
    const seller = await makeSeller();
    const otherSeller = await makeSeller();
    const category = await makeCategory('xcat-suppressed');
    const HASH = 'aaaaaaaaaaaaaaaa';

    await makeProduct({
      seller: otherSeller,
      category,
      title: 'Reference',
      hash: HASH,
      description: 'Reference listing used to seed the pHash duplicate for this test.',
    });
    const probe = await makeProduct({
      seller,
      category,
      title: 'Probe',
      hash: HASH,
      description: 'Probe listing with a deliberately different description from the reference.',
    });

    const result = await detectRisk({
      product: probe,
      hashes: [HASH],
      aiAnalysis: { imageHashes: [HASH] },
      crossCategoryRepost: {
        signal: CROSS_CATEGORY_IMAGE_REPOST_SIGNAL,
        similarity: 0.97,
        similarToTitle: 'Also a duplicate',
      },
    });

    expect(result.factors.some((f) => /Duplicate image detected/.test(f))).toBe(true);
    expect(result.factors.some((f) => /CROSS_CATEGORY_IMAGE_REPOST/.test(f))).toBe(false);
    // Exactly the pHash duplicate weight — the +20 cross-category signal was
    // suppressed, so it never exceeds the pHash weight.
    expect(result.riskScore).toBe(35);
  });
});
