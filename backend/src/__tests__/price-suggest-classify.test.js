/**
 * Tests for suggest-price endpoint and image classification.
 *
 * Covers:
 *  1. GET /api/products/suggest-price â€” enough comparables
 *  2. GET /api/products/suggest-price â€” cold-start (no comparables)
 *  3. GET /api/products/suggest-price â€” condition affects price direction
 *  4. classifyProduct â€” keyword fallback still works
 *  5. classifyProduct â€” returns source field
 *  6. Image classifier â€” IMAGENET_TO_CATEGORY mapping
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { app, server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { classifyProduct } = require('../services/computerVision');
const { classifyImage, IMAGENET_TO_CATEGORY, CONFIDENCE_THRESHOLD } = require('../services/imageClassifier');

const extractToken = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const c = setCookie.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0].split('=')[1] : null;
};

describe('Price Suggestion & Image Classification', () => {
  let seller, token, category;

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
    seller = await User.create({
      name: 'Price Test Seller',
      email: `price-${Date.now()}@example.com`,
      password: 'password123',
      role: 'seller',
      createdAt: new Date(Date.now() - 365 * 86400000),
    });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: seller.email, password: 'password123' });
    token = extractToken(loginRes);

    category = await Category.create({
      name: 'Electronics',
      slug: `electronics-${Date.now()}`,
      icon: 'smartphone',
    });
  });

  // â”€â”€â”€ 1. Suggest price with enough comparables â”€â”€â”€

  describe('GET /api/products/suggest-price', () => {
    it('returns a price suggestion when enough comparables exist', async () => {
      // Create comparable sold products
      for (let i = 0; i < 5; i++) {
        await Product.create({
          title: `Comparable ${i}`,
          description: `Comparable product ${i}`,
          price: 100 + i * 20,
          originalPrice: 200,
          category: category._id,
          images: [{ url: `http://x.com/${i}.jpg`, publicId: `img${i}` }],
          seller: seller._id,
          status: 'sold',
          condition: 'good',
        });
      }

      const res = await request(app)
        .get('/api/products/suggest-price')
        .query({ category: category._id, condition: 'good' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.suggestedPrice).toBeGreaterThan(0);
      expect(res.body.priceRange.min).toBeLessThan(res.body.suggestedPrice);
      expect(res.body.priceRange.max).toBeGreaterThan(res.body.suggestedPrice);
      expect(res.body.comparableCount).toBeGreaterThanOrEqual(5);
      expect(typeof res.body.explanation).toBe('string');
    });

    // â”€â”€â”€ 2. Cold-start: no comparables â”€â”€â”€

    it('returns insufficient data when no comparables and no original price', async () => {
      const res = await request(app)
        .get('/api/products/suggest-price')
        .query({ category: category._id, condition: 'good' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.suggestedPrice).toBe(0);
      expect(res.body.comparableCount).toBe(0);
    });

    // â”€â”€â”€ 3. Condition affects price direction â”€â”€â”€

    it('returns higher price for better condition', async () => {
      // Create comparables
      for (let i = 0; i < 4; i++) {
        await Product.create({
          title: `Item ${i}`,
          description: `Test item ${i}`,
          price: 150,
          originalPrice: 300,
          category: category._id,
          images: [{ url: `http://x.com/${i}.jpg`, publicId: `img${i}` }],
          seller: seller._id,
          condition: 'good',
        });
      }

      const likeNew = await request(app)
        .get('/api/products/suggest-price')
        .query({ category: category._id, condition: 'like-new', originalPrice: 300 })
        .expect(200);

      const fair = await request(app)
        .get('/api/products/suggest-price')
        .query({ category: category._id, condition: 'fair', originalPrice: 300 })
        .expect(200);

      expect(likeNew.body.suggestedPrice).toBeGreaterThan(fair.body.suggestedPrice);
    });

    // â”€â”€â”€ 4. Original price drives depreciation model â”€â”€â”€

    it('uses depreciation model when originalPrice is provided', async () => {
      const res = await request(app)
        .get('/api/products/suggest-price')
        .query({ category: category._id, condition: 'good', originalPrice: 1000, yearsUsed: 1 })
        .expect(200);

      expect(res.body.suggestedPrice).toBeGreaterThan(0);
      expect(res.body.suggestedPrice).toBeLessThan(1000); // depreciated
    });
  });

  // â”€â”€â”€ 5. classifyProduct keyword fallback â”€â”€â”€

  describe('computerVision.classifyProduct', () => {
    it('classifies electronics from title keywords', async () => {
      const buf = Buffer.alloc(100, 0x80);
      const result = await classifyProduct(buf, { title: 'iPhone 14 Pro' });
      expect(result.category).toBe('Electronics');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.source).toBeDefined();
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

    it('returns a source field indicating classification method', async () => {
      const buf = Buffer.alloc(100, 0x80);
      const result = await classifyProduct(buf, { title: 'MacBook Pro' });
      expect(result.source).toBeDefined();
      expect(['image-model', 'keyword', 'none']).toContain(result.source);
    });
  });

  // â”€â”€â”€ 6. Image classifier mapping â”€â”€â”€

  describe('imageClassifier', () => {
    it('has IMAGENET_TO_CATEGORY mapping', () => {
      expect(IMAGENET_TO_CATEGORY).toBeDefined();
      expect(typeof IMAGENET_TO_CATEGORY).toBe('object');
      expect(Object.keys(IMAGENET_TO_CATEGORY).length).toBeGreaterThan(10);
    });

    it('maps common ImageNet labels to ReSell categories', () => {
      expect(IMAGENET_TO_CATEGORY['cellular telephone']).toBe('Electronics');
      expect(IMAGENET_TO_CATEGORY['shoe']).toBe('Fashion');
      expect(IMAGENET_TO_CATEGORY['sofa']).toBe('Home & Garden');
      expect(IMAGENET_TO_CATEGORY['bicycle']).toBe('Sports & Outdoors');
      expect(IMAGENET_TO_CATEGORY['book']).toBe('Books & Media');
      expect(IMAGENET_TO_CATEGORY['toy']).toBe('Toys & Games');
    });

    it('has a defined CONFIDENCE_THRESHOLD', () => {
      expect(typeof CONFIDENCE_THRESHOLD).toBe('number');
      expect(CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
      expect(CONFIDENCE_THRESHOLD).toBeLessThan(1);
    });

    // ──── 7. Real inference (regression guard for the /255 preprocessing bug) ────

    describe('imageClassifier real inference', () => {
      const fs = require('fs');
      const path = require('path');

      const loadFixture = (name) => {
        const p = path.join(__dirname, 'fixtures', name);
        return fs.existsSync(p) ? fs.readFileSync(p) : null;
      };

      it('produces a confident (non-uniform) top-1 prediction on the smoke fixture', async () => {
        const buf = loadFixture('classify-smoke.jpg');
        if (!buf) {
          console.warn('SKIP: backend/src/__tests__/fixtures/classify-smoke.jpg not found');
          return;
        }

        const result = await classifyImage(buf);

        if (result.source === 'unavailable') {
          console.warn('SKIP: MobileNet model unavailable (no network / no weights)');
          return;
        }

        // The /255 preprocessing bug collapses the input to near-black and
        // yields near-uniform predictions (~0.001 top-1). A healthy model
        // is always more confident than this on any real photo.
        expect(result.source).toBe('mobilenet');
        expect(result.topLabels.length).toBeGreaterThan(0);
        expect(result.topLabels[0].probability).toBeGreaterThan(0.05);
      }, 120000);

      it('maps a known labeled fixture to the expected category', async () => {
        const buf = loadFixture('classify-sneaker.jpg');
        if (!buf) {
          console.warn(
            'SKIP: backend/src/__tests__/fixtures/classify-sneaker.jpg not found — drop a clear product photo at this path to enable the labeled assertion'
          );
          return;
        }

        const result = await classifyImage(buf);

        if (result.source === 'unavailable') {
          console.warn('SKIP: MobileNet model unavailable (no network / no weights)');
          return;
        }

        expect(result.source).toBe('mobilenet');
        expect(result.confidence).toBeGreaterThanOrEqual(0.15);
        expect(result.category).not.toBe('Other');
        expect(result.topLabels.length).toBeGreaterThan(0);
      }, 120000);
    });
  });
});
