/**
 * Production-readiness hardening regression tests.
 *
 * Coverage:
 *  - PATCH /products/:id/sold must refuse to toggle listings that are not
 *    'active'/'sold' — a seller can no longer lift a moderation hold via a
 *    flagged -> sold -> active double-toggle, nor flip a listing locked in
 *    'pending' by an open checkout session (regression for markAsSold).
 *  - POST /api/offers must derive currencyCode from the listing instead of
 *    trusting the client (regression for createOffer).
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { app, server } = require('../server');
const Category = require('../models/Category');
const Product = require('../models/Product');
const ProductIdentity = require('../models/ProductIdentity');
const { hashIdentifier } = require('../services/provenance');
const { deleteFromCloudinary } = require('../config/cloudinary');
const { createUser } = require('./helpers');

// Cloudinary is never configured in tests — mock it so the
// cleanupUnreferencedImages regression tests can observe deletions.
jest.mock('../config/cloudinary', () => ({
  uploadToCloudinary: jest.fn(),
  deleteFromCloudinary: jest.fn().mockResolvedValue(true),
}));

// computerVision is mocked so the upload orphan-asset regression can force
// an analysis failure deterministically.
jest.mock('../services/computerVision', () => ({
  assessCondition: jest.fn(),
  detectDamage: jest.fn(),
  classifyProduct: jest.fn(),
}));

// Deterministic stand-ins for the DCT pHash pipeline: the hash is derived
// from the buffer content itself (first 16-hex run found in it), the mirror
// hash is the reversed string. The REAL hammingDistance is preserved so the
// duplicate-detection rules are exercised exactly as in production.
jest.mock('../services/imageHash', () => {
  const actual = jest.requireActual('../services/imageHash');
  const hashFromBuffer = (buffer) => {
    const m = String(buffer).match(/[0-9a-f]{16}/);
    return m ? m[0] : '0000000000000000';
  };
  return {
    ...actual,
    perceptualHashFromBuffer: jest.fn(async (buffer) => hashFromBuffer(buffer)),
    mirrorPerceptualHashFromBuffer: jest.fn(async (buffer) =>
      hashFromBuffer(buffer).split('').reverse().join('')
    ),
  };
});

describe('Hardening regressions', () => {
  let seller, sellerToken, buyerToken, categoryId;

  beforeAll(async () => {
    ({ user: seller, token: sellerToken } = await createUser({
      role: 'seller',
      email: `hardening-seller${Date.now()}@example.com`,
    }));
    ({ token: buyerToken } = await createUser({
      role: 'buyer',
      email: `hardening-buyer${Date.now()}@example.com`,
    }));
  });

  // Standard cleanup (same pattern as orders/checkout tests)
  afterAll(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      if (['users'].includes(key)) continue;
      await collections[key].deleteMany({});
    }
    await server.close();
  });

  const createListing = async (overrides = {}) => {
    const category = await Category.create({
      name: `Hardening Cat ${Date.now()}${Math.random().toString(36).slice(2)}`,
      slug: `hardening-cat-${Date.now()}${Math.random().toString(36).slice(2)}`,
      icon: 'box',
    });
    categoryId = category._id.toString();
    return Product.create({
      title: 'Hardening Test Product',
      description: 'A product for hardening regression tests',
      price: 500,
      currencyCode: 'EUR',
      category: categoryId,
      images: [{ url: 'http://x.com/h.jpg', publicId: 'h' }],
      seller: seller._id,
      ...overrides,
    });
  };

  const markSold = (token, id) =>
    request(app)
      .patch(`/api/products/${id}/sold`)
      .set('Authorization', `Bearer ${token}`);

  describe('PATCH /products/:id/sold state restriction', () => {
    it('still toggles an active listing to sold and back (behavior preserved)', async () => {
      const product = await createListing();
      const first = await markSold(sellerToken, product._id.toString()).expect(200);
      expect(first.body.product.status).toBe('sold');
      const second = await markSold(sellerToken, product._id.toString()).expect(200);
      expect(second.body.product.status).toBe('active');
    });

    it('blocks a flagged listing from being marked sold (moderation hold cannot be lifted)', async () => {
      const product = await createListing({
        status: 'flagged',
        isFlagged: true,
        flagReason: 'Identity flagged — held for moderation',
      });
      await markSold(sellerToken, product._id.toString()).expect(409);
      const updated = await Product.findById(product._id);
      expect(updated.status).toBe('flagged');
    });

    it('blocks a pending listing from being marked sold (checkout lock preserved)', async () => {
      const product = await createListing({ status: 'pending' });
      await markSold(sellerToken, product._id.toString()).expect(409);
      const updated = await Product.findById(product._id);
      expect(updated.status).toBe('pending');
    });

    it('rejects a non-owner (403)', async () => {
      const product = await createListing();
      await markSold(buyerToken, product._id.toString()).expect(403);
    });
  });

  describe('POST /api/offers currency derivation', () => {
    it('derives currencyCode from the product, ignoring the client value', async () => {
      const product = await createListing({ currencyCode: 'EUR' });
      const res = await request(app)
        .post('/api/offers')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          productId: product._id.toString(),
          amount: 100,
          currencyCode: 'USD',
        })
        .expect(201);
      expect(res.body.offer.currencyCode).toBe('EUR');
    });
  });

  describe('PATCH /products/:id/sold restores identity sold -> active', () => {
    it('relisting a sold listing sets the ProductIdentity back to active', async () => {
      const product = await createListing({ status: 'sold' });
      const identity = await ProductIdentity.create({
        productId: product._id,
        identifierType: 'visual',
        identifierHash: 'f'.repeat(64),
        currentOwnerId: seller._id,
        status: 'sold',
      });
      product.productIdentity = identity._id;
      await product.save();

      const res = await markSold(sellerToken, product._id.toString()).expect(200);
      expect(res.body.product.status).toBe('active');

      const updated = await ProductIdentity.findById(identity._id);
      expect(updated.status).toBe('active');
    });

    it('marking a listing sold follows the identity to sold (provenance path)', async () => {
      const product = await createListing();
      const identity = await ProductIdentity.create({
        productId: product._id,
        identifierType: 'visual',
        identifierHash: 'e'.repeat(64),
        currentOwnerId: seller._id,
        status: 'active',
      });
      product.productIdentity = identity._id;
      await product.save();

      await markSold(sellerToken, product._id.toString()).expect(200);
      // The sold direction is recorded via recordSaleProvenance
      const updated = await ProductIdentity.findById(identity._id);
      expect(updated.status).toBe('sold');

      // Relisting restores it (sold -> active)
      await markSold(sellerToken, product._id.toString()).expect(200);
      const relisted = await ProductIdentity.findById(identity._id);
      expect(relisted.status).toBe('active');
    });
  });

  describe('Listing relist re-links dangling identity refs', () => {
    it('relists an identity whose registered product no longer exists and re-links it', async () => {
      const category = await Category.create({
        name: `Laptops ${Date.now()}${Math.random().toString(36).slice(2)}`,
        slug: `laptops-${Date.now()}${Math.random().toString(36).slice(2)}`,
        icon: 'package',
      });

      // Identity registered against a product that no longer exists
      const identifier = 'SER-RELK-1234';
      const identity = await ProductIdentity.create({
        productId: new mongoose.Types.ObjectId(),
        identifierType: 'serial',
        identifierHash: hashIdentifier(identifier, 'serial'),
        currentOwnerId: seller._id,
        status: 'active',
      });

      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          title: 'Relinked ThinkPad',
          description: 'Relisting after the original registration vanished',
          price: 700,
          category: category._id.toString(),
          brand: 'Lenovo',
          condition: 'good',
          identifier,
          identifierType: 'serial',
          images: [
            { url: 'https://example.com/relink-1.jpg', publicId: 'relink-1', hash: 'aabbccdd11223344' },
            { url: 'https://example.com/relink-2.jpg', publicId: 'relink-2', hash: 'c42a171d4bccc04d' },
            { url: 'https://example.com/relink-3.jpg', publicId: 'relink-3', hash: '840074e0679d14f1' },
          ],
          specifications: [],
        })
        .expect(201);

      const updated = await ProductIdentity.findById(identity._id);
      expect(updated.productId.toString()).toBe(res.body.product._id);
    });
  });

  describe('cleanupUnreferencedImages (deleteProduct / rejected updates)', () => {
    it('never deletes a shared asset still referenced by another listing', async () => {
      const productA = await createListing({
        images: [{ url: 'http://x.com/shared.jpg', publicId: 'shared-1' }],
      });
      const productB = await createListing({
        images: [{ url: 'http://x.com/shared.jpg', publicId: 'shared-1' }],
      });

      await request(app)
        .delete(`/api/products/${productA._id.toString()}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);

      // 'shared-1' is still referenced by the second listing
      const deletedPublicIds = deleteFromCloudinary.mock.calls.map((c) => c[0]);
      expect(deletedPublicIds).not.toContain('shared-1');

      // Deleting the second listing makes the asset unreferenced
      await request(app)
        .delete(`/api/products/${productB._id.toString()}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);

      expect(deleteFromCloudinary).toHaveBeenCalledWith('shared-1');
    });
  });

  describe('updateProduct server-side hash re-verification', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      jest.clearAllMocks();
    });

    const stubFetch = (content) => {
      global.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => Buffer.from(content),
      });
    };

    it('recomputes hashes server-side and stores the mirror hash (client hashes never trusted)', async () => {
      const product = await createListing();
      stubFetch('hash:1122334455667788');

      // Multi-image policy: an edit must keep the listing at >= 3 images.
      // All three images resolve through the stubbed fetch, so all get the
      // same server-computed hash — the client hash is still ignored.
      const res = await request(app)
        .put(`/api/products/${product._id.toString()}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          images: [
            { url: 'http://127.0.0.1:9/fresh.jpg', publicId: 'fresh-1', hash: 'deadbeefdeadbeef' },
            { url: 'http://127.0.0.1:9/fresh2.jpg', publicId: 'fresh-2' },
            { url: 'http://127.0.0.1:9/fresh3.jpg', publicId: 'fresh-3' },
          ],
        })
        .expect(200);

      // The client-provided hash is ignored; the server-computed one is stored
      expect(res.body.product.images[0].perceptualHash).toBe('1122334455667788');
      // Both the normal and the mirrored hash are stored for duplicate probes
      expect(res.body.product.aiAnalysis.imageHashes).toEqual(
        expect.arrayContaining(['1122334455667788', '8877665544332211'])
      );
    });

    it('rejects a new image whose server-side hash duplicates an existing listing', async () => {
      // Duplicate detection is scoped to the listing's category — both
      // listings must share one category for the check to see the other.
      const sharedCat = await Category.create({
        name: `Dup Cat ${Date.now()}${Math.random().toString(36).slice(2)}`,
        slug: `dup-cat-${Date.now()}${Math.random().toString(36).slice(2)}`,
        icon: 'box',
      });
      const other = await createListing({
        category: sharedCat._id.toString(),
        aiAnalysis: { imageHashes: ['aabbccdd11223344'] },
      });
      const product = await createListing({ category: sharedCat._id.toString() });
      stubFetch('hash:aabbccdd11223344');

      const res = await request(app)
        .put(`/api/products/${product._id.toString()}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          images: [{ url: 'http://127.0.0.1:9/dup.jpg', publicId: 'dup-1' }],
        })
        .expect(409);

      expect(res.body.code).toBe('DUPLICATE_IMAGE');
      // Nothing was persisted on the rejected listing
      const unchanged = await Product.findById(product._id);
      expect(unchanged.images[0].publicId).toBe('h');
      expect(unchanged.aiAnalysis?.imageHashes || []).not.toContain('aabbccdd11223344');
      // The rejected upload's Cloudinary asset is cleaned up
      expect(deleteFromCloudinary).toHaveBeenCalledWith('dup-1');
      expect(other).toBeTruthy();
    });

    it('catches a mirrored copy of an existing image (mirror-hash probe)', async () => {
      const sharedCat = await Category.create({
        name: `Mirror Cat ${Date.now()}${Math.random().toString(36).slice(2)}`,
        slug: `mirror-cat-${Date.now()}${Math.random().toString(36).slice(2)}`,
        icon: 'box',
      });
      await createListing({
        category: sharedCat._id.toString(),
        aiAnalysis: { imageHashes: ['aabbccdd11223344'] },
      });
      const product = await createListing({ category: sharedCat._id.toString() });

      // The probe's NORMAL hash is the reverse of the stored hash (hamming
      // distance 28 — far above the threshold), but its MIRROR hash matches
      // the stored hash exactly. The mirrored variant must not slip through.
      stubFetch('hash:44332211ddccbbaa');

      const res = await request(app)
        .put(`/api/products/${product._id.toString()}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          images: [{ url: 'http://127.0.0.1:9/mirror.jpg', publicId: 'mirror-1' }],
        })
        .expect(409);

      expect(res.body.code).toBe('DUPLICATE_IMAGE');
      const unchanged = await Product.findById(product._id);
      expect(unchanged.images[0].publicId).toBe('h');
      expect(deleteFromCloudinary).toHaveBeenCalledWith('mirror-1');
    });
  });

  describe('errorHandler — 5xx logging / non-leak', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const buildRes = () => {
      const res = {};
      res.status = jest.fn(() => res);
      res.json = jest.fn(() => res);
      return res;
    };

    it('logs real 5xx failures server-side (status, code, route)', () => {
      const { errorHandler } = require('../utils/errorHandler');
      const err = new Error('payment provider credentials rejected');
      err.statusCode = 502;
      err.code = 'PAYMENT_PROVIDER_FAILURE';
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = buildRes();

      errorHandler(err, { method: 'POST', originalUrl: '/api/checkout/session' }, res, () => {});

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('[Error] 502 PAYMENT_PROVIDER_FAILURE')
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('/api/checkout/session')
      );
      expect(res.status).toHaveBeenCalledWith(502);
    });

    it('never leaks the stack trace in non-development responses', () => {
      const { errorHandler } = require('../utils/errorHandler');
      const err = new Error('internal failure with secrets');
      err.statusCode = 500;
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = buildRes();

      errorHandler(err, { method: 'GET', originalUrl: '/api/x' }, res, () => {});

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.stack).toBeUndefined();
    });

    it('includes the stack trace only in development', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const { errorHandler } = require('../utils/errorHandler');
        const err = new Error('dev failure');
        err.statusCode = 500;
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = buildRes();

        errorHandler(err, { method: 'GET', originalUrl: '/api/x' }, res, () => {});

        const body = res.json.mock.calls[0][0];
        expect(typeof body.stack).toBe('string');
      } finally {
        process.env.NODE_ENV = prev;
      }
    });
  });

  describe('upload duplicate check cannot be scoped away by a client-supplied category', () => {
    it('rejects a duplicate image even when the upload claims a different category', async () => {
      // Reference listing (with the dup hash) lives in category A...
      const sharedCat = await Category.create({
        name: `Scope Cat A ${Date.now()}${Math.random().toString(36).slice(2)}`,
        slug: `scope-cat-a-${Date.now()}${Math.random().toString(36).slice(2)}`,
        icon: 'box',
      });
      await Product.create({
        title: 'Scope Victim',
        description: 'Holds the original image',
        price: 100,
        category: sharedCat._id,
        images: [{ url: 'http://x.com/scope.jpg', publicId: 'scope-1' }],
        seller: seller._id,
        aiAnalysis: { imageHashes: ['aabbccdd11223344'] },
      });
      // ...while the upload lies about belonging to an empty category B
      const emptyCat = await Category.create({
        name: `Scope Cat B ${Date.now()}${Math.random().toString(36).slice(2)}`,
        slug: `scope-cat-b-${Date.now()}${Math.random().toString(36).slice(2)}`,
        icon: 'box',
      });

      // Plain buffer — the mocked perceptualHashFromBuffer derives
      // 'aabbccdd11223344' from the content; multer accepts it because
      // the declared contentType is image/*.
      const res = await request(app)
        .post('/api/products/upload-images')
        .set('Authorization', `Bearer ${sellerToken}`)
        .field('category', emptyCat._id.toString())
        .attach('images', Buffer.from('hash:aabbccdd11223344'), {
          filename: 'scope-dup.png',
          contentType: 'image/png',
        })
        .expect(409);

      expect(res.body.code).toBe('DUPLICATE_IMAGE');
    });
  });

  describe('updateProduct duplicate check covers the original category', () => {
    it('rejects a duplicate image even when the edit changes the category', async () => {
      const sharedCat = await Category.create({
        name: `Edit Cat A ${Date.now()}${Math.random().toString(36).slice(2)}`,
        slug: `edit-cat-a-${Date.now()}${Math.random().toString(36).slice(2)}`,
        icon: 'box',
      });
      await createListing({
        category: sharedCat._id.toString(),
        aiAnalysis: { imageHashes: ['aabbccdd11223344'] },
      });
      // The edited listing starts in sharedCat with 3 existing images
      const product = await Product.create({
        title: 'Edit Scope Target',
        description: 'A product for the mid-edit category-change test',
        price: 500,
        category: sharedCat._id.toString(),
        images: [
          { url: 'http://x.com/e1.jpg', publicId: 'e-1' },
          { url: 'http://x.com/e2.jpg', publicId: 'e-2' },
          { url: 'http://x.com/e3.jpg', publicId: 'e-3' },
        ],
        seller: seller._id,
      });
      const otherCat = await Category.create({
        name: `Edit Cat B ${Date.now()}${Math.random().toString(36).slice(2)}`,
        slug: `edit-cat-b-${Date.now()}${Math.random().toString(36).slice(2)}`,
        icon: 'box',
      });

      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => Buffer.from('hash:aabbccdd11223344'),
      });
      try {
        const res = await request(app)
          .put(`/api/products/${product._id.toString()}`)
          .set('Authorization', `Bearer ${sellerToken}`)
          .send({
            category: otherCat._id.toString(),
            images: [
              { url: 'http://x.com/e1.jpg', publicId: 'e-1' },
              { url: 'http://x.com/e2.jpg', publicId: 'e-2' },
              { url: 'http://x.com/e3.jpg', publicId: 'e-3' },
              { url: 'http://127.0.0.1:9/dup-scope.jpg', publicId: 'dup-scope-1' },
            ],
          })
          .expect(409);

        expect(res.body.code).toBe('DUPLICATE_IMAGE');
        // Nothing was persisted — not even the category change
        const unchanged = await Product.findById(product._id);
        expect(unchanged.category.toString()).toBe(sharedCat._id.toString());
        expect(unchanged.images.map((i) => i.publicId)).toEqual(['e-1', 'e-2', 'e-3']);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('upload orphan-asset cleanup on analysis failure', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    it('deletes an uploaded asset whose CV analysis failed (never orphaned)', async () => {
      const computerVision = require('../services/computerVision');
      const { uploadToCloudinary } = require('../config/cloudinary');
      uploadToCloudinary.mockResolvedValue({
        url: 'http://x.com/orphan.png',
        publicId: 'orphan-1',
        width: 100,
        height: 100,
      });
      computerVision.assessCondition.mockRejectedValue(new Error('cv down'));

      const res = await request(app)
        .post('/api/products/upload-images')
        .set('Authorization', `Bearer ${sellerToken}`)
        .attach('images', Buffer.from('hash:9988776655443322'), {
          filename: 'orphan.png',
          contentType: 'image/png',
        });

      // Analysis failed for the only image -> 500, and the uploaded asset
      // was cleaned up because the client never received its URL.
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('IMAGE_PROCESSING_FAILED');
      expect(deleteFromCloudinary).toHaveBeenCalledWith('orphan-1');
    });

    it('keeps an uploaded asset whose analysis succeeded', async () => {
      const computerVision = require('../services/computerVision');
      const { uploadToCloudinary } = require('../config/cloudinary');
      uploadToCloudinary.mockResolvedValue({
        url: 'http://x.com/kept.png',
        publicId: 'kept-1',
        width: 100,
        height: 100,
      });
      computerVision.assessCondition.mockResolvedValue({ score: 80 });
      computerVision.detectDamage.mockResolvedValue({ score: 10 });
      computerVision.classifyProduct.mockResolvedValue({
        category: 'Electronics',
        confidence: 0.9,
      });

      // 'f0f0f0f0f0f0f0f0' is >12 hamming distance from every hash used
      // elsewhere in this file, so the duplicate check cannot trip on it.
      const res = await request(app)
        .post('/api/products/upload-images')
        .set('Authorization', `Bearer ${sellerToken}`)
        .attach('images', Buffer.from('hash:f0f0f0f0f0f0f0f0'), {
          filename: 'kept.png',
          contentType: 'image/png',
        })
        .expect(200);

      expect(res.body.images[0].publicId).toBe('kept-1');
      expect(deleteFromCloudinary).not.toHaveBeenCalledWith('kept-1');
    });
  });

  describe('admin search escapes regex metacharacters', () => {
    let adminToken;

    beforeAll(async () => {
      ({ token: adminToken } = await createUser({
        role: 'admin',
        email: `hardening-admin${Date.now()}@example.com`,
      }));
    });

    it.each([
      ['(a+)+$', 'catastrophic backtracking pattern'],
      ['(.*)*', 'greedy star-star pattern'],
    ])('completes quickly for /admin/users with "%s" (%s)', async (payload) => {
      const start = Date.now();
      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ q: payload })
        .expect(200);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(res.body.success).toBe(true);
    });

    it.each([
      ['(a+)+$', 'catastrophic backtracking pattern'],
      ['(.*)*', 'greedy star-star pattern'],
    ])('completes quickly for /admin/products with "%s" (%s)', async (payload) => {
      const res = await request(app)
        .get('/api/admin/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ q: payload })
        .expect(200);
      expect(res.body.success).toBe(true);
    });

    it('still matches legitimate text containing special characters', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ q: 'hardening-seller' })
        .expect(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
