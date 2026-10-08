/**
 * Mirror-hash duplicate detection at creation + upload — integration tests.
 *
 * The edit path has always probed both the normal and the mirrored pHash;
 * these tests verify that the same defense now exists at upload-images (409
 * hard gate) and that product creation stores mirror hashes for the probe
 * while flagging duplicates through the fraud engine:
 *  - a horizontally flipped re-upload of an existing image is rejected with
 *    409 DUPLICATE_IMAGE at upload-images;
 *  - creation with a duplicate hash is NOT blocked — detectRisk() flags it
 *    and the flat normal+mirror list is stored for future probes;
 *  - genuinely different images still pass (no false positives).
 */

const request = require('supertest');
const mongoose = require('mongoose');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { app, server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const {
  perceptualHashFromBuffer,
  mirrorPerceptualHashFromBuffer,
} = require('../services/imageHash');

const extractToken = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const c = setCookie.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0].split('=')[1] : null;
};

const loadSmokeFixture = () => {
  const p = path.join(__dirname, 'fixtures', 'classify-smoke.jpg');
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};

describe('Mirror-hash duplicate detection at creation + upload', () => {
  let sellerA, sellerB, sellerBToken, category;

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
    sellerA = await User.create({
      name: 'Seller A',
      email: `mirrorA-${Date.now()}-${Math.random()}@example.com`,
      password: 'password123',
      role: 'seller',
    });
    sellerB = await User.create({
      name: 'Seller B',
      email: `mirrorB-${Date.now()}-${Math.random()}@example.com`,
      password: 'password123',
      role: 'seller',
    });

    const loginB = await request(app)
      .post('/api/auth/login')
      .send({ email: sellerB.email, password: 'password123' });
    sellerBToken = extractToken(loginB);

    category = await Category.create({
      name: 'Mirror Test Cat',
      slug: `mirror-test-cat-${Date.now()}-${Math.random()}`,
      icon: 'box',
    });
  });

  /** Deterministic solid-color test image (far perceptual hash from others). */
  const makeImage = (r, g, b, size = 100) =>
    sharp({
      create: { width: size, height: size, channels: 3, background: { r, g, b } },
    })
      .png()
      .toBuffer();

  it('rejects a flipped re-upload of an existing image at upload-images with 409', async () => {
    const smoke = loadSmokeFixture();
    if (!smoke) {
      console.warn('SKIP: fixtures/classify-smoke.jpg not found');
      return;
    }

    const flipped = await sharp(smoke).flop().png().toBuffer();

    // Reference listing stores BOTH the normal and the mirrored hash
    // (mirrors what the edit path stores in aiAnalysis.imageHashes).
    const refHash = await perceptualHashFromBuffer(smoke);
    const refMirrorHash = await mirrorPerceptualHashFromBuffer(smoke);
    await Product.create({
      title: 'Original Smoke Listing',
      description: 'Holds the original image',
      price: 50,
      category: category._id,
      images: [{ url: 'http://x.com/original.jpg', publicId: 'original' }],
      seller: sellerA._id,
      aiAnalysis: { imageHashes: [refHash, refMirrorHash] },
    });

    const res = await request(app)
      .post('/api/products/upload-images')
      .set('Cookie', `access_token=${sellerBToken}`)
      .attach('images', flipped, { filename: 'flipped.png', contentType: 'image/png' })
      .expect(409);

    expect(res.body.code).toBe('DUPLICATE_IMAGE');
    expect(res.body.message).toMatch(/duplicate/i);
  });

  it('creation with a duplicate hash is risk-flagged (not blocked) and stores mirror hashes', async () => {
    const smoke = loadSmokeFixture();
    if (!smoke) {
      console.warn('SKIP: fixtures/classify-smoke.jpg not found');
      return;
    }

    const flipped = await sharp(smoke).flop().png().toBuffer();
    const refHash = await perceptualHashFromBuffer(smoke);
    const refMirrorHash = await mirrorPerceptualHashFromBuffer(smoke);
    await Product.create({
      title: 'Original Smoke Listing',
      description: 'Holds the original image',
      price: 50,
      category: category._id,
      images: [{ url: 'http://x.com/original.jpg', publicId: 'original' }],
      seller: sellerA._id,
      aiAnalysis: { imageHashes: [refHash, refMirrorHash] },
    });

    // The flipped image's own hash matches the original's stored MIRROR hash.
    // Creation does NOT hard-block duplicates (the 409 gate lives at
    // upload-images) — detectRisk() flags them as a risk signal instead.
    // Two filler images with far hashes keep the 3-image requirement satisfied.
    const farA = await makeImage(255, 80, 20);
    const farB = await makeImage(20, 200, 60);
    const farAHash = await perceptualHashFromBuffer(farA);
    const farAMirror = await mirrorPerceptualHashFromBuffer(farA);
    const farBHash = await perceptualHashFromBuffer(farB);
    const farBMirror = await mirrorPerceptualHashFromBuffer(farB);
    const flippedHash = await perceptualHashFromBuffer(flipped);
    const flippedMirror = await mirrorPerceptualHashFromBuffer(flipped);

    const res = await request(app)
      .post('/api/products')
      .set('Cookie', `access_token=${sellerBToken}`)
      .send({
        title: 'Flipped Mirror Listing',
        description: 'Mirror evasion attempt via direct POST',
        price: 50,
        category: category._id.toString(),
        images: [
          {
            url: 'http://x.com/flipped.jpg',
            publicId: 'flipped',
            hash: flippedHash,
            mirrorHash: flippedMirror,
          },
          { url: 'http://x.com/far-a.jpg', publicId: 'far-a', hash: farAHash, mirrorHash: farAMirror },
          { url: 'http://x.com/far-b.jpg', publicId: 'far-b', hash: farBHash, mirrorHash: farBMirror },
        ],
      })
      .expect(201);

    expect(res.body.success).toBe(true);

    // Stored hashes are the flat normal+mirror list (3 images × 2)
    expect(res.body.product.aiAnalysis.imageHashes.length).toBe(6);
    expect(res.body.product.aiAnalysis.imageHashes).toContain(flippedHash);
    expect(res.body.product.aiAnalysis.imageHashes).toContain(flippedMirror);

    // The fraud engine flags the duplicate as a risk signal
    expect(res.body.product.aiAnalysis.riskAssessment).toBeDefined();
    expect(res.body.product.aiAnalysis.riskAssessment.riskScore).toBeGreaterThanOrEqual(35);
    expect(res.body.product.aiAnalysis.riskAssessment.factors).toContainEqual(
      expect.stringContaining('Duplicate image detected')
    );
  });

  it('allows creation when images are genuinely different (no false positive)', async () => {
    const farA = await makeImage(255, 80, 20);
    const farB = await makeImage(20, 200, 60);
    const farC = await makeImage(90, 40, 200);
    const hashes = [];
    for (const img of [farA, farB, farC]) {
      hashes.push({
        hash: await perceptualHashFromBuffer(img),
        mirrorHash: await mirrorPerceptualHashFromBuffer(img),
      });
    }

    const res = await request(app)
      .post('/api/products')
      .set('Cookie', `access_token=${sellerBToken}`)
      .send({
        title: 'Genuinely Different Listing',
        description: 'Normal listing with unique images',
        price: 50,
        category: category._id.toString(),
        images: [
          { url: 'http://x.com/a.jpg', publicId: 'a', hash: hashes[0].hash, mirrorHash: hashes[0].mirrorHash },
          { url: 'http://x.com/b.jpg', publicId: 'b', hash: hashes[1].hash, mirrorHash: hashes[1].mirrorHash },
          { url: 'http://x.com/c.jpg', publicId: 'c', hash: hashes[2].hash, mirrorHash: hashes[2].mirrorHash },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // Stored hashes are the flat normal+mirror list
    expect(res.body.product.aiAnalysis.imageHashes.length).toBe(6);
  });
});
