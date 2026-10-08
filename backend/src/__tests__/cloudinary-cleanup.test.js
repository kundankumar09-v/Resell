/**
 * Cloudinary orphan-asset cleanup + legacy listings removal (T8).
 *
 * Covers:
 *  - rejected edits clean up newly uploaded unreferenced assets through
 *    the real deleteFromCloudinary utility (config/cloudinary)
 *  - shared/existing assets are never destroyed — on rejection and on
 *    listing deletion alike
 *  - Cloudinary cleanup failures are handled safely (logged, never
 *    silently swallowed, never masking the original result)
 *  - no invalid `uploadToCloudinary.deleteFromCloudinary` call remains
 *  - canonical /api/products behavior remains intact
 *  - legacy /api/listings is removed (it was completely unused)
 */

const request = require('supertest');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { app, server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { perceptualHashFromBuffer } = require('../services/imageHash');

// Spy on the canonical Cloudinary deletion utility while keeping the
// real (safe no-op when unconfigured) behavior.
jest.mock('../config/cloudinary', () => {
  const actual = jest.requireActual('../config/cloudinary');
  return {
    ...actual,
    deleteFromCloudinary: jest.fn(actual.deleteFromCloudinary),
  };
});

const { uploadToCloudinary, deleteFromCloudinary } = require('../config/cloudinary');

const extractToken = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const c = setCookie.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0].split('=')[1] : null;
};

const toDataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;

describe('Cloudinary orphan cleanup + legacy listings (T8)', () => {
  let seller, sellerToken, category, product;

  /** Solid-color test image */
  const makeImage = (r, g, b, size = 100) =>
    sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();

  beforeAll(async () => {
    // server module is loaded at require time; nothing needed here
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

  beforeEach(async () => {
    deleteFromCloudinary.mockClear();
    deleteFromCloudinary.mockReset();
    deleteFromCloudinary.mockImplementation(jest.requireActual('../config/cloudinary').deleteFromCloudinary);

    seller = await User.create({
      name: 'Cleanup Seller',
      email: `cleanup-${Date.now()}@example.com`,
      password: 'password123',
      role: 'seller',
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: seller.email, password: 'password123' });
    sellerToken = extractToken(login);

    category = await Category.create({
      name: 'Cleanup Cat',
      slug: `cleanup-cat-${Date.now()}`,
      icon: 'box',
    });

    product = await Product.create({
      title: 'Cleanup Target',
      description: 'Listing whose images get cleaned up',
      price: 100,
      category: category._id,
      images: [{ url: 'http://x.com/own.jpg', publicId: 'own-img' }],
      seller: seller._id,
      status: 'active',
      aiAnalysis: { imageHashes: [] },
    });
  });

  describe('rejected edits clean up newly uploaded assets', () => {
    it('deletes the new asset through deleteFromCloudinary but keeps the existing one', async () => {
      // Victim listing with a known image hash — editing our listing with
      // the same image is rejected as a duplicate.
      const dupBuffer = await makeImage(120, 30, 90);
      const dupHash = await perceptualHashFromBuffer(dupBuffer);
      await Product.create({
        title: 'Victim',
        description: 'Owns the original image',
        price: 100,
        category: category._id,
        images: [{ url: 'http://x.com/dup.jpg', publicId: 'dup-img' }],
        seller: seller._id,
        status: 'active',
        aiAnalysis: { imageHashes: [dupHash] },
      });

      const res = await request(app)
        .put(`/api/products/${product._id}`)
        .set('Cookie', `access_token=${sellerToken}`)
        .send({
          images: [{ url: toDataUrl(dupBuffer), publicId: 'freshly-uploaded-1' }],
        })
        .expect(409);

      expect(res.body.code).toBe('DUPLICATE_IMAGE');

      // The canonical Cloudinary deletion utility was used for the new asset
      expect(deleteFromCloudinary).toHaveBeenCalledWith('freshly-uploaded-1');
      // The listing's existing asset is untouched by a failed edit
      expect(deleteFromCloudinary).not.toHaveBeenCalledWith('own-img');

      // Nothing was persisted
      const after = await Product.findById(product._id);
      expect(after.images.map((i) => i.publicId)).toEqual(['own-img']);
    });

    it('keeps assets that are referenced by another listing', async () => {
      const asym = await makeImage(120, 30, 90);
      const asymHash = await perceptualHashFromBuffer(asym);

      // 'shared-img' is owned by a second listing — must never be deleted
      await Product.create({
        title: 'Shared asset owner',
        description: 'References shared-img',
        price: 10,
        category: category._id,
        images: [{ url: 'http://x.com/shared.jpg', publicId: 'shared-img' }],
        seller: seller._id,
        status: 'active',
        aiAnalysis: { imageHashes: [] },
      });

      // Victim listing whose image the first new entry duplicates
      await Product.create({
        title: 'Victim',
        description: 'Owns the original image',
        price: 100,
        category: category._id,
        images: [{ url: 'http://x.com/dup.jpg', publicId: 'dup-img' }],
        seller: seller._id,
        status: 'active',
        aiAnalysis: { imageHashes: [asymHash] },
      });

      // Edit introduces a duplicate (rejected) and re-sends the shared asset
      await request(app)
        .put(`/api/products/${product._id}`)
        .set('Cookie', `access_token=${sellerToken}`)
        .send({
          images: [
            { url: toDataUrl(asym), publicId: 'rejected-new-1' },
            { url: toDataUrl(asym), publicId: 'shared-img' },
          ],
        })
        .expect(409);

      expect(deleteFromCloudinary).toHaveBeenCalledWith('rejected-new-1');
      expect(deleteFromCloudinary).not.toHaveBeenCalledWith('shared-img');
      expect(deleteFromCloudinary).not.toHaveBeenCalledWith('own-img');
    });

    it('handles a Cloudinary cleanup failure safely on a rejected edit', async () => {
      deleteFromCloudinary.mockRejectedValue(new Error('cloud is down'));

      const dupBuffer = await makeImage(200, 200, 5);
      const dupHash = await perceptualHashFromBuffer(dupBuffer);
      await Product.create({
        title: 'Victim',
        description: 'Owns the original image',
        price: 100,
        category: category._id,
        images: [{ url: 'http://x.com/dup.jpg', publicId: 'dup-img' }],
        seller: seller._id,
        status: 'active',
        aiAnalysis: { imageHashes: [dupHash] },
      });

      // The original rejection (409 duplicate) is preserved — the cleanup
      // failure is logged and swallowed, never masking the real result.
      const res = await request(app)
        .put(`/api/products/${product._id}`)
        .set('Cookie', `access_token=${sellerToken}`)
        .send({
          images: [{ url: toDataUrl(dupBuffer), publicId: 'rejected-new-2' }],
        })
        .expect(409);

      expect(res.body.code).toBe('DUPLICATE_IMAGE');
      expect(deleteFromCloudinary).toHaveBeenCalledWith('rejected-new-2');
    });
  });

  describe('listing deletion never destroys shared assets', () => {
    it('deletes exclusive assets but keeps ones referenced by another listing', async () => {
      product.images.push({ url: 'http://x.com/shared.jpg', publicId: 'shared-img', isPrimary: false });
      await product.save();

      await Product.create({
        title: 'Shared asset owner',
        description: 'References shared-img',
        price: 10,
        category: category._id,
        images: [{ url: 'http://x.com/shared.jpg', publicId: 'shared-img' }],
        seller: seller._id,
        status: 'active',
        aiAnalysis: { imageHashes: [] },
      });

      await request(app)
        .delete(`/api/products/${product._id}`)
        .set('Cookie', `access_token=${sellerToken}`)
        .expect(200);

      expect(deleteFromCloudinary).toHaveBeenCalledWith('own-img');
      expect(deleteFromCloudinary).not.toHaveBeenCalledWith('shared-img');

      const after = await Product.findById(product._id);
      expect(after.status).toBe('removed');
    });

    it('handles a Cloudinary cleanup failure safely on deletion', async () => {
      deleteFromCloudinary.mockRejectedValue(new Error('cloud is down'));

      await request(app)
        .delete(`/api/products/${product._id}`)
        .set('Cookie', `access_token=${sellerToken}`)
        .expect(200);

      expect(deleteFromCloudinary).toHaveBeenCalledWith('own-img');
      const after = await Product.findById(product._id);
      expect(after.status).toBe('removed');
    });
  });

  describe('no invalid deleteFromCloudinary call remains', () => {
    it('uploadToCloudinary has no deleteFromCloudinary method', () => {
      // Documents the original bug: the legacy code called a nonexistent
      // method on the upload function instead of the imported utility.
      expect(typeof uploadToCloudinary.deleteFromCloudinary).toBe('undefined');
      expect(typeof deleteFromCloudinary).toBe('function');
    });

    it('no source file calls uploadToCloudinary.deleteFromCloudinary', () => {
      const invalid = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            // Production source only — the test fixtures below assert on
            // this very string.
            if (entry.name === '__tests__') continue;
            walk(full);
          } else if (entry.name.endsWith('.js')) {
            const content = fs.readFileSync(full, 'utf8');
            if (content.includes('uploadToCloudinary.deleteFromCloudinary')) {
              invalid.push(path.relative(process.cwd(), full));
            }
          }
        }
      };
      walk(path.join(__dirname, '..'));

      expect(invalid).toEqual([]);
    });
  });

  describe('legacy /api/listings is removed', () => {
    it('no longer serves any listing route', async () => {
      await request(app).get('/api/listings/search').expect(404);
      await request(app).get(`/api/listings/${product._id}`).expect(404);
      await request(app)
        .post('/api/listings')
        .set('Cookie', `access_token=${sellerToken}`)
        .send({})
        .expect(404);
    });

    it('the legacy implementation files are gone', () => {
      const backend = path.join(__dirname, '..');
      expect(fs.existsSync(path.join(backend, 'routes', 'listings.js'))).toBe(false);
      expect(fs.existsSync(path.join(backend, 'controllers', 'duplicateController.js'))).toBe(false);
      expect(fs.existsSync(path.join(backend, 'services', 'duplicateDetection.js'))).toBe(false);
    });
  });

  describe('canonical /api/products remains intact', () => {
    it('still lists, creates, updates and deletes products', async () => {
      const list = await request(app).get('/api/products').expect(200);
      expect(list.body.success).toBe(true);
      expect(Array.isArray(list.body.items)).toBe(true);

      const created = await request(app)
        .post('/api/products')
        .set('Cookie', `access_token=${sellerToken}`)
        .send({
          title: 'Canonical Product',
          description: 'Created through the canonical Product API',
          price: 42,
          category: category._id.toString(),
          images: [
          { url: 'https://example.com/img.jpg', publicId: 'canonical-1' },
          { url: 'https://example.com/img2.jpg', publicId: 'canonical-2' },
          { url: 'https://example.com/img3.jpg', publicId: 'canonical-3' },
        ],
        })
        .expect(201);
      expect(created.body.product.title).toBe('Canonical Product');

      const updated = await request(app)
        .put(`/api/products/${created.body.product._id}`)
        .set('Cookie', `access_token=${sellerToken}`)
        .send({ price: 45 })
        .expect(200);
      expect(updated.body.product.price).toBe(45);

      await request(app)
        .delete(`/api/products/${created.body.product._id}`)
        .set('Cookie', `access_token=${sellerToken}`)
        .expect(200);
    });
  });
});
