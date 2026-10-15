/**
 * Multi-object image handling (README §7.12) — unit + integration tests.
 *
 * COCO-SSD is mocked (no network weights); MobileNet runs for real so the
 * per-crop classification + embedding path is genuinely exercised on a
 * sharp-generated fixture image.
 *
 * Covered:
 *   - single object              -> status quo (whole-image flow unchanged)
 *   - multi-object               -> primary = top score, crop embedding fingerprinted
 *   - none                       -> whole-image fallback, never an error
 *   - detector throws            -> graceful fallback, listing creation never blocked
 *   - PUT primaryObjectIndex     -> re-points the category suggestion at the chosen crop
 */

jest.mock('@tensorflow-models/coco-ssd', () => ({
  load: jest.fn(),
}));

const mongoose = require('mongoose');
const request = require('supertest');
const sharp = require('sharp');
const { server, app } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const cocoSsd = require('@tensorflow-models/coco-ssd');
const {
  analyzeDetectedObjects,
  detectObjects,
  deduplicateDetections,
  boxIoU,
  OBJECT_DETECTION_MIN_SCORE,
} = require('../services/imageClassifier');
const {
  buildProductFingerprint,
  compareProductFingerprints,
  primaryCropFeatures,
} = require('../services/productFingerprint');

const fakeDetector = { detect: jest.fn() };
cocoSsd.load.mockResolvedValue(fakeDetector);

/** Solid-colour PNG fixture (400x300 — under the 800px detection cap, scale 1). */
const makeImage = (color = { r: 200, g: 100, b: 50 }) =>
  sharp({ create: { width: 400, height: 300, channels: 3, background: color } })
    .png()
    .toBuffer();

describe('Multi-object image handling', () => {
  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    fakeDetector.detect.mockReset();
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  // ── Pure geometry helpers (no DB, no models) ───────────────────────────────

  describe('boxIoU / deduplicateDetections', () => {
    it('identical boxes have IoU 1, disjoint boxes IoU 0', () => {
      expect(boxIoU([10, 10, 100, 100], [10, 10, 100, 100])).toBeCloseTo(1, 5);
      expect(boxIoU([0, 0, 10, 10], [20, 20, 10, 10])).toBe(0);
    });

    it('overlaps above 0.6 keep only the highest score', () => {
      const dets = [
        { bbox: [20, 20, 100, 100], score: 0.8 },
        { bbox: [10, 10, 100, 100], score: 0.9 },
        { bbox: [250, 200, 50, 50], score: 0.7 },
      ];
      const kept = deduplicateDetections(dets);
      expect(kept.map((d) => d.score)).toEqual([0.9, 0.7]);
    });
  });

  // ── Detection (mocked COCO-SSD) ────────────────────────────────────────────

  describe('detectObjects', () => {
    it('filters boxes below the score threshold and sorts by score', async () => {
      fakeDetector.detect.mockResolvedValue([
        { bbox: [200, 150, 60, 60], class: 'cup', score: 0.62 },
        { bbox: [10, 10, 120, 120], class: 'bottle', score: 0.93 },
        { bbox: [300, 10, 40, 40], class: 'mouse', score: 0.2 },
      ]);
      const res = await detectObjects(await makeImage());
      expect(res.available).toBe(true);
      expect(res.objects.map((o) => o.label)).toEqual(['bottle', 'cup']);
      expect(res.objects[0].score).toBeCloseTo(0.93, 3);
      expect(OBJECT_DETECTION_MIN_SCORE).toBe(0.5);
    });

    it('no detections -> available with an empty list (whole-image fallback)', async () => {
      fakeDetector.detect.mockResolvedValue([]);
      const res = await detectObjects(await makeImage());
      expect(res.available).toBe(true);
      expect(res.objects).toEqual([]);
    });

    it('detector throws -> unavailable, never throws', async () => {
      fakeDetector.detect.mockRejectedValue(new Error('GPU gone'));
      const res = await detectObjects(await makeImage());
      expect(res.available).toBe(false);
      expect(res.reason).toBe('detection_error');
    });
  });

  // ── Per-crop analysis ──────────────────────────────────────────────────────

  describe('analyzeDetectedObjects', () => {
    // Real MobileNet inference on CPU (model download + per-crop classify and
    // embedding) exceeds the suite-wide 30s timeout — these two bump it.
    it('single object: status quo — one analysed crop, whole-image flow untouched', async () => {
      fakeDetector.detect.mockResolvedValue([
        { bbox: [50, 40, 200, 180], class: 'bottle', score: 0.91 },
      ]);
      const { objects } = await analyzeDetectedObjects(await makeImage());
      expect(objects).toHaveLength(1);
      expect(objects[0].label).toBe('bottle');
      expect(objects[0].bbox).toEqual({ x: 50, y: 40, width: 200, height: 180 });
      expect(typeof objects[0].cropClassification).toBe('string');
      expect(typeof objects[0].cropConfidence).toBe('number');
      expect(Array.isArray(objects[0].cropEmbedding)).toBe(true);
    }, 180000);

    it('multi-object: primary is the top score, each crop classified + embedded', async () => {
      fakeDetector.detect.mockResolvedValue([
        { bbox: [220, 150, 120, 100], class: 'cup', score: 0.76 },
        { bbox: [10, 10, 150, 160], class: 'bottle', score: 0.93 },
      ]);
      const { objects } = await analyzeDetectedObjects(await makeImage());
      expect(objects).toHaveLength(2);
      expect(objects[0].label).toBe('bottle');
      expect(objects[0].score).toBeGreaterThan(objects[1].score);
      for (const o of objects) {
        expect(typeof o.cropClassification).toBe('string');
        expect(Array.isArray(o.cropEmbedding)).toBe(true);
      }
    }, 180000);

    it('none: empty objects (caller falls back to whole-image analysis)', async () => {
      fakeDetector.detect.mockResolvedValue([]);
      const { objects } = await analyzeDetectedObjects(await makeImage());
      expect(objects).toEqual([]);
    });

    it('detector throws: graceful empty result, never rejects', async () => {
      fakeDetector.detect.mockRejectedValue(new Error('boom'));
      await expect(analyzeDetectedObjects(await makeImage())).resolves.toEqual(
        expect.objectContaining({ objects: [] })
      );
    });
  });

  // ── Fingerprint from the primary crop ──────────────────────────────────────

  describe('primary crop fingerprint', () => {
    const cropProduct = (embeddings, primaryObjectIndex = null) => ({
      images: [],
      aiAnalysis: {
        multiObject: embeddings.length >= 2,
        primaryObjectIndex,
        detectedObjects: embeddings.map((cropEmbedding, i) => ({
          bbox: { x: i * 10, y: 0, width: 50, height: 50 },
          label: `item-${i}`,
          score: 0.9 - i * 0.1,
          cropClassification: 'Electronics',
          cropConfidence: 0.8,
          cropEmbedding,
        })),
      },
    });

    it('uses the highest-score (index 0) crop by default', () => {
      const p = cropProduct([[1, 0, 0], [0, 1, 0]]);
      expect(primaryCropFeatures(p)).toEqual([1, 0, 0]);
    });

    it('honours an explicit primaryObjectIndex override', () => {
      const p = cropProduct([[1, 0, 0], [0, 1, 0]], 1);
      expect(primaryCropFeatures(p)).toEqual([0, 1, 0]);
    });

    it('bundle photo matches a single photo of the same item crop-vs-crop', () => {
      const bundle = cropProduct([[1, 0, 0], [0, 1, 0]]);
      const single = cropProduct([[1, 0, 0]]);
      const comparison = compareProductFingerprints(
        buildProductFingerprint(bundle),
        buildProductFingerprint(single)
      );
      expect(comparison.available).toBe(true);
      expect(comparison.similarity).toBeCloseTo(1, 5);
    });

    it('no crops and no CNN features -> unavailable (never fraud)', () => {
      expect(buildProductFingerprint({ images: [] }).available).toBe(false);
    });
  });

  // ── PUT primaryObjectIndex ─────────────────────────────────────────────────

  describe('PUT /api/products/:id primaryObjectIndex', () => {
    let token;
    let sellerId;
    let productId;

    const loginAs = async (email, password = 'password123') => {
      const res = await request(app).post('/api/auth/login').send({ email, password });
      const setCookie = res.headers['set-cookie'] || [];
      const access = setCookie.find((c) => c.startsWith('access_token='));
      return access ? access.split(';')[0] : '';
    };

    beforeEach(async () => {
      const seller = await User.create({
        name: 'Multi Seller',
        email: `multi-${Date.now()}@example.com`,
        password: 'password123',
        role: 'seller',
      });
      sellerId = seller._id;
      const cookie = await loginAs(seller.email);
      token = cookie;
      const category = await Category.create({ name: 'Phones', slug: 'phones', icon: 'phone' });
      const product = await Product.create({
        title: 'Bundle: bottle plus cup',
        description: 'Two items photographed together for this test.',
        price: 100,
        category: category._id,
        images: [{ url: 'http://x.com/cover.jpg', publicId: 'cover1' }],
        seller: sellerId,
        aiAnalysis: {
          multiObject: true,
          primaryObjectIndex: 0,
          detectedObjects: [
            {
              bbox: { x: 10, y: 10, width: 150, height: 160 },
              label: 'bottle',
              score: 0.93,
              cropClassification: 'Electronics',
              cropConfidence: 0.8,
              cropEmbedding: [0.5, 0.5],
            },
            {
              bbox: { x: 220, y: 150, width: 120, height: 100 },
              label: 'cup',
              score: 0.76,
              cropClassification: 'Home & Garden',
              cropConfidence: 0.7,
              cropEmbedding: [0.1, 0.9],
            },
          ],
        },
      });
      productId = product._id.toString();
    });

    it('re-points the category suggestion at the chosen crop', async () => {
      const res = await request(app)
        .put(`/api/products/${productId}`)
        .set('Cookie', token)
        .send({ primaryObjectIndex: 1 })
        .expect(200);

      expect(res.body.product.aiAnalysis.primaryObjectIndex).toBe(1);
      expect(res.body.product.aiAnalysis.classification.predictedCategory).toBe('Home & Garden');
    });

    it('rejects an out-of-range index without touching the listing', async () => {
      await request(app)
        .put(`/api/products/${productId}`)
        .set('Cookie', token)
        .send({ primaryObjectIndex: 7 })
        .expect(400);

      const fresh = await Product.findById(productId).lean();
      expect(fresh.aiAnalysis.primaryObjectIndex).toBe(0);
    });
  });
});
