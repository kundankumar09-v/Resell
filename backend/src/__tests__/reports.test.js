const request = require('supertest');
const mongoose = require('mongoose');
const { app, server } = require('../server');
const User = require('../models/User');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Report = require('../models/Report');
const { createUser } = require('./helpers');

describe('Report Routes', () => {
  let adminToken, buyerToken, productId, buyerUserId;

  beforeAll(async () => {
    const admin = await createUser({ role: 'admin', email: 'reportadmin@example.com' });
    adminToken = admin.token;
    const buyer = await createUser({ role: 'buyer', email: 'reportbuyer@example.com' });
    buyerToken = buyer.token;
    buyerUserId = buyer.user._id;
    const category = await Category.create({ name: 'Test', slug: 'test-reports', icon: 'box' });
    const product = await Product.create({
      title: 'Reportable Product', description: 'Test', price: 50,
      category: category._id, images: [{ url: 'http://x.com/1.jpg', publicId: 'a' }],
      seller: buyer.user._id,
    });
    productId = product._id.toString();
  });

  // Standard cleanup (same pattern as orders/checkout tests): without this,
  // the shared in-memory DB keeps the 'Test' category and later test files
  // (e.g. priceSweep) fail with a duplicate-key error on Category.name.
  afterAll(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      if (['users'].includes(key)) continue;
      await collections[key].deleteMany({});
    }
    await server.close();
  });

  describe('POST /api/reports', () => {
    it('requires auth', async () => {
      await request(app)
        .post('/api/reports')
        .send({ targetType: 'product', target: productId, reason: 'spam' })
        .expect(401);
    });

    it('creates report', async () => {
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({ targetType: 'product', target: productId, reason: 'spam', description: 'Test report' })
        .expect(201);
      expect(res.body.success).toBe(true);
    });

    it('validates required fields (400)', async () => {
      await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({})
        .expect(400);
    });
  });

  describe('GET /api/reports', () => {
    it('returns reports for admin', async () => {
      await Report.create({
        reporter: buyerUserId, targetType: 'product',
        target: productId, reason: 'spam',
      });
      const res = await request(app)
        .get('/api/reports')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('rejects non-admin (403)', async () => {
      await request(app)
        .get('/api/reports')
        .set('Authorization', `Bearer ${buyerToken}`)
        .expect(403);
    });
  });
});
