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
describe('Product Routes', () => {
  let userToken;
  let sellerToken;
  let adminToken;
  let categoryId;
  let sellerId;

  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  });

  const setupUsers = async () => {
    const buyer = await User.create({
      name: 'Test Buyer',
      email: `buyer-${Date.now()}@example.com`,
      password: 'password123',
      role: 'buyer',
    });

    const seller = await User.create({
      name: 'Test Seller',
      email: `seller-${Date.now()}@example.com`,
      password: 'password123',
      role: 'seller',
    });
    sellerId = seller._id;

    const admin = await User.create({
      name: 'Test Admin',
      email: `admin-${Date.now()}@example.com`,
      password: 'password123',
      role: 'admin',
    });

    const category = await Category.create({
      name: 'Test Category',
      slug: `test-category-${Date.now()}`,
      icon: 'package',
    });
    categoryId = category._id.toString();

    const buyerRes = await request(app)
      .post('/api/auth/login')
      .send({ email: buyer.email, password: 'password123' });
    userToken = extractToken(buyerRes);

    const sellerRes = await request(app)
      .post('/api/auth/login')
      .send({ email: seller.email, password: 'password123' });
    sellerToken = extractToken(sellerRes);

    const adminRes = await request(app)
      .post('/api/auth/login')
      .send({ email: admin.email, password: 'password123' });
    adminToken = extractToken(adminRes);
  };

  beforeEach(async () => {
    await setupUsers();
  });

  describe('GET /api/products', () => {
    it('should return paginated products', async () => {
      const res = await request(app)
        .get('/api/products')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.items).toBeDefined();
      expect(res.body.pagination).toBeDefined();
    });

    it('should filter by category', async () => {
      const res = await request(app)
        .get('/api/products')
        .query({ category: categoryId })
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should filter by price range', async () => {
      const res = await request(app)
        .get('/api/products')
        .query({ minPrice: 10, maxPrice: 100 })
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should validate query parameters', async () => {
      const res = await request(app)
        .get('/api/products')
        .query({ page: -1 })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/products/:id', () => {
    let productId;

    beforeEach(async () => {
      const product = await Product.create({
        title: 'Test Product',
        description: 'Test description for product',
        price: 100,
        originalPrice: 150,
        category: categoryId,
        brand: 'TestBrand',
        condition: 'good',
        images: [{ url: 'https://example.com/image.jpg', publicId: 'test123' }],
        seller: sellerId,
      });
      productId = product._id.toString();
    });

    it('should return product by id', async () => {
      const res = await request(app)
        .get(`/api/products/${productId}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.product.title).toBe('Test Product');
    });

    it('should return 404 for non-existent product', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`/api/products/${fakeId}`)
        .expect(404);

      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/products (create)', () => {
    it('should create product as seller', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          title: 'New Product',
          description: 'A great product description',
          price: 200,
          originalPrice: 250,
          category: categoryId,
          brand: 'BrandX',
          condition: 'like-new',
          yearsUsed: 1,
          images: threeImages({ url: 'https://example.com/img.jpg', publicId: 'img123', hash: 'abc123' }),
          specifications: [{ key: 'Color', value: 'Red' }],
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.product.title).toBe('New Product');
      expect(res.body.product.aiAnalysis).toBeDefined();
    });

    it('should reject listings with fewer than three images', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          title: 'Two-view Product',
          description: 'A product with too few images',
          price: 200,
          category: categoryId,
          images: threeImages({ url: 'https://example.com/img.jpg', publicId: 'img123', hash: 'abc123' }).slice(0, 2),
        })
        .expect(400);

      // The 3-image minimum is enforced in ONE place (validation middleware,
      // sharing MIN_IMAGES with the controller via src/constants.js) — a
      // 2-image listing now gets a single consistent validation error.
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toMatch(/3 images/i);
      expect(await Product.countDocuments({ title: 'Two-view Product' })).toBe(0);
    });

    it('should reject creation without auth', async () => {
      const res = await request(app)
        .post('/api/products')
        .send({
          title: 'New Product',
          description: 'Description',
          price: 100,
          category: categoryId,
          images: [{ url: 'https://example.com/img.jpg', publicId: 'img123' }],
        })
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('should validate required fields', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({})
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should validate price is positive', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          title: 'Test',
          description: 'Description',
          price: -10,
          category: categoryId,
          images: [{ url: 'https://example.com/img.jpg', publicId: 'img123' }],
        })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PUT /api/products/:id (update)', () => {
    let productId;

    beforeEach(async () => {
      const product = await Product.create({
        title: 'Product to Update',
        description: 'Original description',
        price: 150,
        category: categoryId,
        images: [{ url: 'https://example.com/img.jpg', publicId: 'img123' }],
        seller: sellerId,
      });
      productId = product._id.toString();
    });

    it('should update own product', async () => {
      const res = await request(app)
        .put(`/api/products/${productId}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({
          title: 'Updated Title',
          price: 180,
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.product.title).toBe('Updated Title');
      expect(res.body.product.price).toBe(180);
    });

    it('should reject update by non-owner', async () => {
      const otherSeller = await User.create({
        name: 'Other Seller',
        email: `other-${Date.now()}@example.com`,
        password: 'password123',
        role: 'seller',
      });

      const otherTokenRes = await request(app)
        .post('/api/auth/login')
        .send({ email: otherSeller.email, password: 'password123' });

      const res = await request(app)
        .put(`/api/products/${productId}`)
        .set('Authorization', `Bearer ${extractToken(otherTokenRes)}`)
        .send({ title: 'Hacked Title' })
        .expect(403);

      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('should allow admin to update any product', async () => {
      const res = await request(app)
        .put(`/api/products/${productId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Admin Updated' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.product.title).toBe('Admin Updated');
    });
  });

  describe('DELETE /api/products/:id', () => {
    let productId;

    beforeEach(async () => {
      const product = await Product.create({
        title: 'Product to Delete',
        description: 'Description',
        price: 100,
        category: categoryId,
        images: [{ url: 'https://example.com/img.jpg', publicId: 'img123' }],
        seller: sellerId,
      });
      productId = product._id.toString();
    });

    it('should delete own product', async () => {
      const res = await request(app)
        .delete(`/api/products/${productId}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/products/:id/similar', () => {
    let productId;

    beforeEach(async () => {
      const product = await Product.create({
        title: 'Similar Product Test',
        description: 'Description',
        price: 100,
        category: categoryId,
        brand: 'SimilarBrand',
        condition: 'good',
        images: [{ url: 'https://example.com/img.jpg', publicId: 'img123' }],
        seller: sellerId,
      });
      productId = product._id.toString();
    });

    it('should return similar products', async () => {
      const res = await request(app)
        .get(`/api/products/${productId}/similar`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.items).toBeDefined();
    });
  });
});
