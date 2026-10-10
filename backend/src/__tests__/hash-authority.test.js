/**
 * SCRUM-31 — Server-side hash authority at createProduct.
 *
 * Hash/mirrorHash reach createProduct via the CLIENT echoing the upload
 * response. A crafted API call could previously omit or fabricate them,
 * silently bypassing duplicate detection and risk flagging. The computed
 * hashes are now persisted server-side at upload time (ImageUploadRecord,
 * keyed by user + publicId) and createProduct reads them back:
 *  - a crafted payload omitting hashes still stores the correct hashes,
 *    recovered from the server-side record;
 *  - fabricated hashes lose — the server values win;
 *  - legacy images (no server-side record) fall back to the echoed value
 *    but are flagged via aiAnalysis.hashesUnverified=true — never
 *    hard-failed.
 *
 * SCRUM-27 semantics are unchanged: the 409 hard gate stays at the upload
 * gate only; creation flows through detectRisk().
 */

const request = require('supertest');
const mongoose = require('mongoose');
const sharp = require('sharp');
const { app, server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const ImageUploadRecord = require('../models/ImageUploadRecord');
const {
  perceptualHashFromBuffer,
  mirrorPerceptualHashFromBuffer,
} = require('../services/imageHash');

// The real uploadToCloudinary needs real credentials; the upload-side
// persistence test mocks it while keeping deleteFromCloudinary real
// (safe no-op when unconfigured).
jest.mock('../config/cloudinary', () => {
  const actual = jest.requireActual('../config/cloudinary');
  return {
    ...actual,
    uploadToCloudinary: jest.fn(),
  };
});

const { uploadToCloudinary } = require('../config/cloudinary');

const extractToken = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const c = setCookie.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0].split('=')[1] : null;
};

describe('SCRUM-31 server-side hash authority at createProduct', () => {
  let seller, sellerToken, category;

  /** Deterministic solid-color test image (far perceptual hash from others). */
  const makeImage = (r, g, b, size = 100) =>
    sharp({
      create: { width: size, height: size, channels: 3, background: { r, g, b } },
    })
      .png()
      .toBuffer();

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
    uploadToCloudinary.mockReset();

    seller = await User.create({
      name: 'Hash Authority Seller',
      email: `hashauth-${Date.now()}-${Math.random()}@example.com`,
      password: 'password123',
      role: 'seller',
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: seller.email, password: 'password123' });
    sellerToken = extractToken(login);

    category = await Category.create({
      name: 'Hash Authority Cat',
      slug: `hash-authority-cat-${Date.now()}-${Math.random()}`,
      icon: 'box',
    });
  });

  /** Seed a server-side upload record the way uploadImages persists one. */
  const seedRecord = async (publicId, buffer) => {
    const hash = await perceptualHashFromBuffer(buffer);
    const mirrorHash = await mirrorPerceptualHashFromBuffer(buffer);
    await ImageUploadRecord.create({
      user: seller._id,
      publicId,
      url: `http://x.com/${publicId}.jpg`,
      hash,
      mirrorHash,
    });
    return { hash, mirrorHash };
  };

  const createListing = (images, overrides = {}) =>
    request(app)
      .post('/api/products')
      .set('Cookie', `access_token=${sellerToken}`)
      .send({
        title: 'Hash Authority Listing',
        description: 'Server-side hash authority test listing',
        price: 50,
        category: category._id.toString(),
        images,
        ...overrides,
      });

  // Long timeout: the first CV inference after boot (MobileNet warm-up)
  // can take well over the default 30s.
  it(
    'upload-images persists the computed hashes server-side keyed by (user, publicId)',
    async () => {
    const imageBuffer = await makeImage(30, 140, 255);
    uploadToCloudinary.mockResolvedValue({
      url: 'https://res.cloudinary.com/demo/uploaded.png',
      publicId: 'uploaded',
      width: 100,
      height: 100,
    });

    const res = await request(app)
      .post('/api/products/upload-images')
      .set('Cookie', `access_token=${sellerToken}`)
      .attach('images', imageBuffer, { filename: 'uploaded.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.images[0].publicId).toBe('uploaded');

    const record = await ImageUploadRecord.findOne({
      user: seller._id,
      publicId: 'uploaded',
    }).lean();
    expect(record).toBeTruthy();
    expect(record.hash).toBe(res.body.images[0].hash);
    expect(record.mirrorHash).toBe(res.body.images[0].mirrorHash);
    expect(record.hash).toBe(await perceptualHashFromBuffer(imageBuffer));
    },
    180000
  );

  it('stores the correct hashes when a crafted payload omits them (recovered server-side)', async () => {
    const srvA = await makeImage(30, 140, 255);
    const srvB = await makeImage(255, 80, 20);
    const srvC = await makeImage(90, 40, 200);
    const recA = await seedRecord('srv-a', srvA);
    const recB = await seedRecord('srv-b', srvB);
    const recC = await seedRecord('srv-c', srvC);

    // Crafted payload: NO hash/mirrorHash fields at all.
    const res = await createListing([
      { url: 'http://x.com/srv-a.jpg', publicId: 'srv-a' },
      { url: 'http://x.com/srv-b.jpg', publicId: 'srv-b' },
      { url: 'http://x.com/srv-c.jpg', publicId: 'srv-c' },
    ]).expect(201);

    expect(res.body.success).toBe(true);

    const stored = res.body.product.aiAnalysis.imageHashes;
    expect(stored.length).toBe(6);
    expect(stored).toContain(recA.hash);
    expect(stored).toContain(recA.mirrorHash);
    expect(stored).toContain(recB.hash);
    expect(stored).toContain(recB.mirrorHash);
    expect(stored).toContain(recC.hash);
    expect(stored).toContain(recC.mirrorHash);

    // Server-side records existed — hashes are verified, not flagged.
    expect(res.body.product.aiAnalysis.hashesUnverified).toBe(false);
  });

  it('lets the server values win when the payload fabricates hashes', async () => {
    const srvA = await makeImage(30, 140, 255);
    const srvB = await makeImage(255, 80, 20);
    const srvC = await makeImage(90, 40, 200);
    const recA = await seedRecord('srv-a', srvA);
    const recB = await seedRecord('srv-b', srvB);
    const recC = await seedRecord('srv-c', srvC);

    const fabricated = 'f'.repeat(16);
    const fabricatedMirror = '0'.repeat(16);

    const res = await createListing([
      {
        url: 'http://x.com/srv-a.jpg',
        publicId: 'srv-a',
        hash: fabricated,
        mirrorHash: fabricatedMirror,
      },
      {
        url: 'http://x.com/srv-b.jpg',
        publicId: 'srv-b',
        hash: fabricated,
        mirrorHash: fabricatedMirror,
      },
      {
        url: 'http://x.com/srv-c.jpg',
        publicId: 'srv-c',
        hash: fabricated,
        mirrorHash: fabricatedMirror,
      },
    ]).expect(201);

    const stored = res.body.product.aiAnalysis.imageHashes;
    expect(stored.length).toBe(6);
    // Fabricated values never reach storage — server values win.
    expect(stored).not.toContain(fabricated);
    expect(stored).not.toContain(fabricatedMirror);
    expect(stored).toContain(recA.hash);
    expect(stored).toContain(recA.mirrorHash);
    expect(stored).toContain(recB.hash);
    expect(stored).toContain(recC.mirrorHash);

    expect(res.body.product.aiAnalysis.hashesUnverified).toBe(false);
  });

  it('falls back to echoed hashes for legacy images (no record) and flags hashesUnverified=true', async () => {
    const imgA = await makeImage(30, 140, 255);
    const imgB = await makeImage(255, 80, 20);
    const imgC = await makeImage(90, 40, 200);
    const hashA = await perceptualHashFromBuffer(imgA);
    const mirrorA = await mirrorPerceptualHashFromBuffer(imgA);
    const hashB = await perceptualHashFromBuffer(imgB);
    const hashC = await perceptualHashFromBuffer(imgC);

    // No ImageUploadRecord exists — legacy echo path.
    const res = await createListing([
      { url: 'http://x.com/legacy-a.jpg', publicId: 'legacy-a', hash: hashA, mirrorHash: mirrorA },
      { url: 'http://x.com/legacy-b.jpg', publicId: 'legacy-b', hash: hashB, mirrorHash: hashB },
      { url: 'http://x.com/legacy-c.jpg', publicId: 'legacy-c', hash: hashC, mirrorHash: hashC },
    ]).expect(201);

    const stored = res.body.product.aiAnalysis.imageHashes;
    expect(stored.length).toBe(6);
    expect(stored).toContain(hashA);
    expect(stored).toContain(mirrorA);

    // Legacy hashes are unverified — flagged for the fraud engine, never
    // hard-failed.
    expect(res.body.product.aiAnalysis.hashesUnverified).toBe(true);
  });
});
