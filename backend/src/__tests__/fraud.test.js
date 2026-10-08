const request = require('supertest');
const mongoose = require('mongoose');
const { app, server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');

const extractToken = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const c = setCookie.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0].split('=')[1] : null;
};


// Minimum 3 images (multi-angle requirement): the given first image plus two
// padding images whose hashes are pairwise >13 hamming distance from every
// fixture hash in this suite (verified computationally).
const threeImages = (first) => [
  first,
  { url: 'https://example.com/pad-1.jpg', publicId: 'pad-1', hash: 'c42a171d4bccc04d' },
  { url: 'https://example.com/pad-2.jpg', publicId: 'pad-2', hash: '840074e0679d14f1' },
];
describe('Fraud Detection', () => {
  let sellerToken;
  let sellerUserId;
  let categoryId;

  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  const setupFraudTest = async () => {
    const seller = await User.create({
      name: 'Fraud Seller',
      email: `fraud-${Date.now()}@example.com`,
      password: 'password123',
      role: 'seller',
    });
    sellerUserId = seller._id;

    const category = await Category.create({
      name: `Fraud Category ${Date.now()}`,
      slug: `fraud-category-${Date.now()}`,
      icon: 'package',
    });
    categoryId = category._id.toString();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: seller.email, password: 'password123' });
    sellerToken = extractToken(res);
  };

  beforeEach(async () => {
    await setupFraudTest();
  });

  describe('Duplicate image detection', () => {
    it('should flag products with duplicate image hashes', async () => {
      // Create first product with a specific hash
      const product1 = await Product.create({
        title: 'Original Product',
        description: 'Original description',
        price: 100,
        category: categoryId,
        brand: 'TestBrand',
        condition: 'good',
        images: [{ url: 'https://example.com/img1.jpg', publicId: 'img1' }],
        seller: sellerUserId,
        aiAnalysis: { imageHashes: ['aabbccdd11223344'] },
      });

      // Create second product with same hash
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          title: 'Duplicate Product',
          description: 'Duplicate description',
          price: 80,
          category: categoryId,
          brand: 'TestBrand',
          condition: 'good',
          images: threeImages({ url: 'https://example.com/img2.jpg', publicId: 'img2', hash: 'aabbccdd11223344' }),
          specifications: [],
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.product.aiAnalysis.riskAssessment).toBeDefined();
      expect(res.body.product.aiAnalysis.riskAssessment.riskScore).toBeGreaterThanOrEqual(35);
      expect(res.body.product.aiAnalysis.riskAssessment.factors).toContainEqual(
        expect.stringContaining('Duplicate image detected')
      );
    });
  });

  describe('Suspicious pricing detection', () => {
    it('should flag suspiciously low price', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          title: 'Very Cheap Product',
          description: 'Description',
          price: 10,
          originalPrice: 1000,
          category: categoryId,
          brand: 'TestBrand',
          condition: 'good',
          images: threeImages({ url: 'https://example.com/img.jpg', publicId: 'img3', hash: 'hash-456' }),
          specifications: [],
        })
        .expect(201);

      expect(res.body.product.aiAnalysis.riskAssessment).toBeDefined();
      expect(res.body.product.aiAnalysis.riskAssessment.riskScore).toBeGreaterThanOrEqual(25);
      expect(res.body.product.aiAnalysis.riskAssessment.factors).toContainEqual(
        expect.stringContaining('suspiciously low')
      );
    });

    it('should flag high price above original', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          title: 'Overpriced Product',
          description: 'Description',
          price: 2000,
          originalPrice: 1000,
          category: categoryId,
          brand: 'TestBrand',
          condition: 'good',
          images: threeImages({ url: 'https://example.com/img.jpg', publicId: 'img4', hash: 'hash-789' }),
          specifications: [],
        })
        .expect(201);

      expect(res.body.product.aiAnalysis.riskAssessment).toBeDefined();
      expect(res.body.product.aiAnalysis.riskAssessment.factors).toContainEqual(
        expect.stringContaining('above original price')
      );
    });
  });

  describe('New account with high-value listing', () => {
    it('should flag new account with high value listing', async () => {
      const newUser = await User.create({
        name: 'New User',
        email: 'newuser@example.com',
        password: 'password123',
        role: 'seller',
      });

      const newTokenRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'newuser@example.com', password: 'password123' });

      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${extractToken(newTokenRes)}`)
        .send({
          title: 'Expensive Item',
          description: 'Description',
          price: 6000,
          originalPrice: 8000,
          category: categoryId,
          brand: 'TestBrand',
          condition: 'good',
          images: threeImages({ url: 'https://example.com/img.jpg', publicId: 'img5', hash: 'hash-new' }),
          specifications: [],
        })
        .expect(201);

      expect(res.body.product.aiAnalysis.riskAssessment).toBeDefined();
      expect(res.body.product.aiAnalysis.riskAssessment.riskScore).toBeGreaterThanOrEqual(15);
      expect(res.body.product.aiAnalysis.riskAssessment.factors).toContainEqual(
        expect.stringContaining('High-value listing from new account')
      );
    });
  });
});