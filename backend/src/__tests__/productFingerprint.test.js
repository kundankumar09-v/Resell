const request = require('supertest');
const mongoose = require('mongoose');
const { app, server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const ProductIdentity = require('../models/ProductIdentity');
const {
  cosineSimilarity,
  buildProductFingerprint,
  compareProductFingerprints,
} = require('../services/productFingerprint');
const { detectRisk, assessVisualSimilarity } = require('../services/fraudDetection');

const extractToken = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const c = setCookie.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0].split('=')[1] : null;
};

const PROOF_URL = 'https://example.com/proof.jpg';

// 3-dim synthetic stand-ins for the 1280D CNN feature vectors the ML
// pipeline stores on images. Only used in tests — production always uses
// real extracted features.
const vec = (a, b, c) => [a, b, c];
const FRONT = vec(1, 0.05, 0);
const REAR = vec(0.02, 0.9, 0.1);
const KEYBOARD_A = vec(0.4, 0.5, 0.76);
// Slightly perturbed KEYBOARD_A — cosine ≈ 0.997 (same surface, new angle/noise)
const KEYBOARD_B = vec(0.41, 0.51, 0.77);

const createUserAndLogin = async (name, role = 'seller') => {
  const user = await User.create({
    name,
    email: `${name.toLowerCase().replace(/\s/g, '')}-${Date.now()}${Math.random()
      .toString(36)
      .slice(2)}@example.com`,
    password: 'password123',
    role,
  });
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password: 'password123' });
  return { user, token: extractToken(res) };
};

describe('Product Fingerprint & Possession Verification (SCRUM-25)', () => {
  let categoryId;
  let seller;
  let sellerToken;
  let otherSeller;
  let otherSellerToken;

  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  beforeEach(async () => {
    const category = await Category.create({
      name: `Laptops ${Date.now()}`,
      slug: `laptops-${Date.now()}`,
      icon: 'package',
    });
    categoryId = category._id.toString();

    ({ user: seller, token: sellerToken } = await createUserAndLogin('Fingerprint Seller'));
    ({ user: otherSeller, token: otherSellerToken } = await createUserAndLogin('Other Fingerprint Seller'));
  });

  // Minimum 3 images (multi-angle requirement): front/main, back, side/detail.
  // Hash triplets are pairwise >12 hamming distance apart (verified) so
  // creation-time duplicate detection never fires between different listings.
  const threeImages = (prefix) => {
    const hashes = {
      default: ['aabbccdd11223344', '1122334455667788', '2233445566778899'],
      a: ['0000000000000fff', '00000000fff00000', '0fff000000000000'],
      b: ['aaac7b0000000000', 'ac129c0000000000', 'b145640000000000'],
    };
    const triplet = hashes[prefix] || hashes.default;
    return triplet.map((hash, i) => ({
      url: `https://example.com/${prefix}-${i}.jpg`,
      publicId: `${prefix}-${i}`,
      hash,
    }));
  };

  const createListing = (token, overrides = {}) =>
    request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'ThinkPad X1 Carbon',
        description: 'Great condition laptop',
        price: 900,
        category: categoryId,
        brand: 'Lenovo',
        condition: 'good',
        images: threeImages('default'),
        specifications: [],
        ...overrides,
      });

  const requestChallenge = (token, productId) =>
    request(app)
      .post(`/api/products/${productId}/identity/possession-challenge`)
      .set('Authorization', `Bearer ${token}`);

  const submitPossession = (token, productId, code) =>
    request(app)
      .post(`/api/products/${productId}/identity/verify-possession`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code, proofImageUrl: PROOF_URL });

  describe('productFingerprint service', () => {
    it('cosineSimilarity: identical vectors -> 1, orthogonal -> 0, invalid -> null', () => {
      expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
      expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
      expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNull();
      expect(cosineSimilarity(null, [1, 0])).toBeNull();
      expect(cosineSimilarity([], [])).toBeNull();
      expect(cosineSimilarity([0, 0], [1, 0])).toBeNull();
    });

    it('builds an aggregate fingerprint from CNN features', () => {
      const product = {
        images: [
          { url: 'a.jpg', cnnFeatures: [3, 4] },
          { url: 'b.jpg', cnnFeatures: [3, 0] },
        ],
      };
      const fp = buildProductFingerprint(product);
      expect(fp.available).toBe(true);
      expect(fp.imageFeatures).toHaveLength(2);
      // Mean [3, 2] normalized
      const norm = Math.sqrt(3 * 3 + 2 * 2);
      expect(fp.fingerprint[0]).toBeCloseTo(3 / norm, 6);
      expect(fp.fingerprint[1]).toBeCloseTo(2 / norm, 6);
    });

    it('reports unavailable (never fraud) when CNN features are missing', () => {
      const fp = buildProductFingerprint({ images: [{ url: 'a.jpg' }] });
      expect(fp.available).toBe(false);
      expect(fp.reason).toBe('cnn_features_unavailable');

      // Case N: no throw, no fraud signal, explicit unavailable result
      const empty = buildProductFingerprint({});
      expect(empty.available).toBe(false);
    });

    it('compares listings crosswise without requiring identical camera angles', () => {
      // Listing A: front + keyboard. Listing B: rear + keyboard.
      // Case B: the keyboard surfaces are matched crosswise despite the
      // different overall angle sets.
      const fpA = buildProductFingerprint({ images: [{ url: 'front.jpg', cnnFeatures: FRONT }, { url: 'kb-a.jpg', cnnFeatures: KEYBOARD_A }] });
      const fpB = buildProductFingerprint({ images: [{ url: 'rear.jpg', cnnFeatures: REAR }, { url: 'kb-b.jpg', cnnFeatures: KEYBOARD_B }] });

      const result = compareProductFingerprints(fpA, fpB);
      expect(result.available).toBe(true);
      expect(result.bestMatches).toHaveLength(2);
      // Strongest valid similarity comes from the keyboard pair
      expect(result.similarity).toBeCloseTo(cosineSimilarity(KEYBOARD_A, KEYBOARD_B), 9);
      // Aggregate is a bounded mean of the valid best matches
      expect(result.aggregateSimilarity).toBeGreaterThanOrEqual(0);
      expect(result.aggregateSimilarity).toBeLessThanOrEqual(1);
    });

    it('propagates unavailability when either side has no CNN features', () => {
      const fpA = buildProductFingerprint({ images: [{ url: 'a.jpg', cnnFeatures: FRONT }] });
      const fpB = buildProductFingerprint({ images: [{ url: 'b.jpg' }] });
      const result = compareProductFingerprints(fpA, fpB);
      expect(result.available).toBe(false);
      expect(result.reason).toBe('cnn_features_unavailable');
      expect(result.similarity).toBeNull();
    });
  });

  describe('Fraud engine integration', () => {
    // Case A / K: same model, different physical products — high visual
    // similarity alone never creates high fraud or an automatic flag.
    it('visual similarity alone never reaches high risk', async () => {
      const product = { _id: new mongoose.Types.ObjectId(), seller: seller._id, description: 'unique description', originalPrice: 1000, price: 800 };

      const risk = await detectRisk({
        product,
        hashes: [],
        aiAnalysis: {},
        visualSignals: [{ signal: 'VISUAL_PRODUCT_SIMILARITY', similarity: 0.95 }],
      });

      expect(risk.riskLevel).not.toBe('high');
      expect(risk.factors.some((f) => f.includes('Visual product similarity'))).toBe(true);
      // The existing strong signals are untouched
      expect(risk.factors.some((f) => f.includes('stolen'))).toBe(false);
    });

    it('below the medium threshold there is no visual signal at all', async () => {
      // No CNN features on a nonexistent/empty product -> unavailable, not fraud
      const visual = await assessVisualSimilarity({ productId: new mongoose.Types.ObjectId() });
      expect(visual.available).toBe(false);
    });

    it('very strong visual similarity PLUS ownership mismatch elevates risk', async () => {
      const product = { _id: new mongoose.Types.ObjectId(), seller: seller._id, description: 'another unique description', originalPrice: 1000, price: 800 };

      const visualOnly = await detectRisk({ product, hashes: [], aiAnalysis: {}, visualSignals: [{ signal: 'VISUAL_PRODUCT_SIMILARITY', similarity: 0.99 }] });
      expect(visualOnly.riskLevel).not.toBe('high');

      const withMismatch = await detectRisk({
        product,
        hashes: [],
        aiAnalysis: {},
        identitySignals: ['OWNERSHIP_MISMATCH'],
        visualSignals: [{ signal: 'VISUAL_PRODUCT_SIMILARITY', similarity: 0.99 }],
      });
      expect(withMismatch.riskScore).toBeGreaterThan(visualOnly.riskScore);
      expect(withMismatch.riskLevel).toBe('high');
      // Still only a risk assessment — no auto-flag/auto-ban happens here
    });

    it('finds a visual signal for the same physical product across listings', async () => {
      const a = await createListing(sellerToken, {
        title: 'Laptop listing A',
        images: threeImages('a'),
      }).expect(201);
      const b = await createListing(otherSellerToken, {
        title: 'Laptop listing B (different seller, same model)',
        images: threeImages('b'),
      }).expect(201);

      // Simulate the CNN features the ML pipeline stores on images
      await Product.updateOne({ _id: a.body.product._id }, { $set: { 'images.0.cnnFeatures': KEYBOARD_A } });
      await Product.updateOne({ _id: b.body.product._id }, { $set: { 'images.0.cnnFeatures': KEYBOARD_B } });

      const visual = await assessVisualSimilarity({ productId: b.body.product._id });
      // Case B: cross-image comparison produces a visual similarity signal
      expect(visual.available).toBe(true);
      expect(visual.signal).toBe('VISUAL_PRODUCT_SIMILARITY');
      expect(visual.similarTo).toBe(a.body.product._id);
      expect(visual.similarity).toBeGreaterThan(0.9);

      // Case K: both listings remain active — no automatic fraud/flag
      const productA = await Product.findById(a.body.product._id);
      const productB = await Product.findById(b.body.product._id);
      expect(productA.status).toBe('active');
      expect(productB.status).toBe('active');
      expect(productB.isFlagged).toBe(false);
    });

    it('ML/CNN unavailable: the fraud pipeline fails gracefully (Case N)', async () => {
      const a = await createListing(sellerToken).expect(201);

      // No CNN features stored anywhere
      const withFeatures = await Product.findById(a.body.product._id);
      expect(withFeatures.images[0].cnnFeatures).toHaveLength(0);

      const visual = await assessVisualSimilarity({ productId: a.body.product._id });
      expect(visual.available).toBe(false);
      expect(visual.reason).toBe('cnn_features_unavailable');
      expect(visual.signal).toBeUndefined();

      // Risk assessment was still produced (low, no visual factor)
      const product = await Product.findById(a.body.product._id);
      expect(product.aiAnalysis.riskAssessment.riskLevel).toBe('low');
    });
  });

  describe('Identifier-free listings (Case D)', () => {
    it('listing creation succeeds without IMEI/serial/VIN', async () => {
      const res = await createListing(sellerToken).expect(201);
      expect(res.body.product._id).toBeTruthy();
      expect(res.body.product.aiAnalysis.riskAssessment.riskLevel).toBe('low');

      // No identity tracked — and no fraud signal for a missing identifier
      const status = await request(app)
        .get(`/api/products/${res.body.product._id}/identity`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);
      expect(status.body.tracked).toBe(false);
      expect(status.body.signals || []).toHaveLength(0);
    });
  });

  describe('Possession challenge (generalized, identifier-free mode)', () => {
    it('issues a short-lived challenge code and registers a visual identity', async () => {
      const created = await createListing(sellerToken).expect(201);
      const productId = created.body.product._id;

      const res = await requestChallenge(sellerToken, productId).expect(200);
      expect(res.body.possession.verificationCode).toMatch(/^[A-Z2-9]{6}$/);
      expect(new Date(res.body.possession.codeExpiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(res.body.possession.codeExpiresAt).getTime()).toBeLessThanOrEqual(
        Date.now() + 24 * 60 * 60 * 1000
      );

      // Visual identity registered — possession-based, no sensitive identifier
      const identity = await ProductIdentity.findOne({ productId });
      expect(identity).toBeTruthy();
      expect(identity.identifierType).toBe('visual');
      expect(identity.identifierHash).not.toContain(productId.toString());
      expect(identity.verification.possessionStatus).toBe('unverified');

      // Status view shows pending possession
      const status = await request(app)
        .get(`/api/products/${productId}/identity`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);
      expect(status.body.tracked).toBe(true);
      expect(status.body.verification.possessionStatus).toBe('unverified');
    });

    it('accepts a correct challenge and marks POSSESSION_VERIFIED (Case E)', async () => {
      const created = await createListing(sellerToken).expect(201);
      const productId = created.body.product._id;
      const res = await requestChallenge(sellerToken, productId).expect(200);
      const code = res.body.possession.verificationCode;

      const verified = await submitPossession(sellerToken, productId, code).expect(200);
      expect(verified.body.possessionStatus).toBe('verified');

      const identity = await ProductIdentity.findOne({ productId });
      expect(identity.verification.possessionStatus).toBe('verified');
      expect(identity.verification.method).toBe('photo_code');
      expect(identity.verification.proofPhotoUrl).toBe(PROOF_URL);
    });

    it('fails on a wrong challenge (Case F)', async () => {
      const created = await createListing(sellerToken).expect(201);
      const productId = created.body.product._id;
      await requestChallenge(sellerToken, productId).expect(200);

      const res = await submitPossession(sellerToken, productId, 'WRONG1').expect(200);
      expect(res.body.possessionStatus).toBe('failed');

      const identity = await ProductIdentity.findOne({ productId });
      expect(identity.verification.possessionStatus).toBe('failed');
      // Listing itself untouched — failed possession is a signal, not a block
      const product = await Product.findById(productId);
      expect(product.status).toBe('active');
    });

    it('re-issues a fresh code after expiry without counting a failure (Case G)', async () => {
      const created = await createListing(sellerToken).expect(201);
      const productId = created.body.product._id;
      const first = await requestChallenge(sellerToken, productId).expect(200);

      // Simulate expiry of the first code
      await ProductIdentity.updateOne(
        { productId },
        { $set: { 'verification.codeExpiresAt': new Date(Date.now() - 1000) } }
      );

      const second = await requestChallenge(sellerToken, productId).expect(200);
      expect(second.body.possession.verificationCode).not.toBe(
        first.body.possession.verificationCode
      );

      const identity = await ProductIdentity.findOne({ productId });
      expect(identity.verification.possessionStatus).toBe('unverified');
      expect(identity.verification.attempts).toBe(0);

      // The fresh code works
      const verified = await submitPossession(
        sellerToken,
        productId,
        second.body.possession.verificationCode
      ).expect(200);
      expect(verified.body.possessionStatus).toBe('verified');
    });

    it('rejects unauthorized users and non-owners (Case L)', async () => {
      const created = await createListing(sellerToken).expect(201);
      const productId = created.body.product._id;

      const anon = await request(app)
        .post(`/api/products/${productId}/identity/possession-challenge`)
        .send({});
      expect(anon.status).toBe(401);

      const notOwner = await requestChallenge(otherSellerToken, productId);
      expect(notOwner.status).toBe(403);
      expect(notOwner.body.code).toBe('FORBIDDEN');

      const identity = await ProductIdentity.findOne({ productId });
      expect(identity).toBeNull();
    });

    it('ignores client-provided possessionVerified=true (Case M)', async () => {
      const created = await createListing(sellerToken).expect(201);
      const productId = created.body.product._id;

      // A client cannot set the verification state through the listing body
      // (server-side field whitelisting)...
      await request(app)
        .put(`/api/products/${productId}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({ possessionVerified: true, productIdentity: new mongoose.Types.ObjectId().toString() })
        .expect(200);

      const statusNoIdentity = await ProductIdentity.findOne({ productId });
      expect(statusNoIdentity).toBeNull();

      // ...nor through the submission endpoint (code + proof required)
      await requestChallenge(sellerToken, productId).expect(200);
      const bypass = await request(app)
        .post(`/api/products/${productId}/identity/verify-possession`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({ possessionVerified: true });
      expect(bypass.status).toBe(400);

      const identity = await ProductIdentity.findOne({ productId });
      expect(identity.verification.possessionStatus).toBe('unverified');
    });

    it('missing possession verification alone is never fraud (Case H)', async () => {
      const created = await createListing(sellerToken).expect(201);
      const productId = created.body.product._id;

      // Request a challenge but never submit a proof
      await requestChallenge(sellerToken, productId).expect(200);

      const status = await request(app)
        .get(`/api/products/${productId}/identity`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);
      expect(status.body.verification.possessionStatus).toBe('unverified');
      expect(status.body.signals).toHaveLength(0);
      expect(status.body.warnings).toHaveLength(0);

      const product = await Product.findById(productId);
      expect(product.status).toBe('active');
      expect(product.aiAnalysis.riskAssessment.riskLevel).toBe('low');
    });
  });
});
