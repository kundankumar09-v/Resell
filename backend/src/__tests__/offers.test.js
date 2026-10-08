/**
 * Offer authorization & state-transition tests (T1).
 *
 * Security coverage:
 *  - PUT /offers/:id by an unrelated third user -> 403
 *  - POST /offers/:id/counter by an unrelated third user -> 403
 *  - POST /offers/:id/counter by the buyer (offer creator) -> 403
 *  - buyer cannot accept/reject; seller cannot withdraw (role-restricted)
 *
 * Valid-transition coverage (model rules preserved):
 *  - buyer withdraws own pending offer
 *  - seller accepts / rejects pending offers
 *  - seller counters -> original becomes 'countered', new pending offer
 *  - terminal-state offers reject further transitions (400)
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { app, server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Offer = require('../models/Offer');

const extractToken = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const c = setCookie.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0].split('=')[1] : null;
};

const createUserAndLogin = async (name, role = 'buyer') => {
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

describe('Offers — authorization & transitions', () => {
  let seller, sellerToken, buyer, buyerToken, third, thirdToken, productId, categoryId;

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
    ({ user: seller, token: sellerToken } = await createUserAndLogin('Offer Seller', 'seller'));
    ({ user: buyer, token: buyerToken } = await createUserAndLogin('Offer Buyer', 'buyer'));
    ({ user: third, token: thirdToken } = await createUserAndLogin('Third User', 'buyer'));

    const category = await Category.create({
      name: `Offers Cat ${Date.now()}`,
      slug: `offers-cat-${Date.now()}`,
      icon: 'box',
    });
    categoryId = category._id.toString();

    const product = await Product.create({
      title: 'Offerable Product',
      description: 'Product used for offer tests',
      price: 500,
      category: categoryId,
      images: [{ url: 'http://x.com/o.jpg', publicId: 'o' }],
      seller: seller._id,
    });
    productId = product._id.toString();
  });

  const makeOffer = (token, amount = 400) =>
    request(app)
      .post('/api/offers')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, amount, message: 'Would you take this?' });

  const updateOffer = (token, offerId, status) =>
    request(app)
      .put(`/api/offers/${offerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status });

  const counterOffer = (token, offerId, amount) =>
    request(app)
      .post(`/api/offers/${offerId}/counter`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount });

  describe('Offer creation', () => {
    it('lets a buyer make an offer on another user’s active product', async () => {
      const res = await makeOffer(buyerToken).expect(201);
      expect(res.body.offer.status).toBe('pending');
      expect(res.body.offer.amount).toBe(400);
      expect(res.body.offer.buyer._id).toBe(buyer._id.toString());
      expect(res.body.offer.seller._id).toBe(seller._id.toString());
    });

    it('rejects offers on the seller’s own product', async () => {
      await makeOffer(sellerToken).expect(400);
    });
  });

  describe('PUT /offers/:id authorization', () => {
    it('forbids an unrelated third user from updating an offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);

      const res = await updateOffer(thirdToken, body.offer._id, 'accepted').expect(403);
      expect(res.body.code).toBe('FORBIDDEN');

      const unchanged = await Offer.findById(body.offer._id);
      expect(unchanged.status).toBe('pending');
    });

    it('forbids the buyer from accepting an offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      const res = await updateOffer(buyerToken, body.offer._id, 'accepted').expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('forbids the buyer from rejecting an offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await updateOffer(buyerToken, body.offer._id, 'rejected').expect(403);
    });

    it('forbids the seller from withdrawing the buyer’s offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      const res = await updateOffer(sellerToken, body.offer._id, 'withdrawn').expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('allows the buyer to withdraw their own pending offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      const res = await updateOffer(buyerToken, body.offer._id, 'withdrawn').expect(200);
      expect(res.body.offer.status).toBe('withdrawn');
    });

    it('allows the seller to accept a pending offer via PUT', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      const res = await updateOffer(sellerToken, body.offer._id, 'accepted').expect(200);
      expect(res.body.offer.status).toBe('accepted');
      expect(res.body.offer.history.length).toBe(2);
      expect(res.body.offer.history[1].actor.toString()).toBe(seller._id.toString());
    });

    it('rejects manually countering or expiring via PUT', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await updateOffer(sellerToken, body.offer._id, 'countered').expect(400);
      await updateOffer(sellerToken, body.offer._id, 'expired').expect(400);
    });
  });

  describe('POST /offers/:id/counter authorization', () => {
    it('forbids an unrelated third user from countering an offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      const res = await counterOffer(thirdToken, body.offer._id, 450).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');

      const unchanged = await Offer.findById(body.offer._id);
      expect(unchanged.status).toBe('pending');
      expect(await Offer.countDocuments({ parentOffer: body.offer._id })).toBe(0);
    });

    it('forbids the buyer (offer creator) from countering their own offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await counterOffer(buyerToken, body.offer._id, 450).expect(403);
    });

    it('lets the seller counter: original countered, new pending offer created', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);

      const res = await counterOffer(sellerToken, body.offer._id, 450).expect(201);
      expect(res.body.offer.status).toBe('pending');
      expect(res.body.offer.amount).toBe(450);
      expect(res.body.offer.parentOffer).toBe(body.offer._id);
      expect(res.body.offer.buyer._id).toBe(buyer._id.toString());

      const original = await Offer.findById(body.offer._id);
      expect(original.status).toBe('countered');

      // The seller cannot counter twice — 'countered' cannot re-counter
      const secondOffer = await Offer.findOne({ parentOffer: body.offer._id });
      await counterOffer(sellerToken, secondOffer._id, 460).expect(201);
      const rejectedAgain = await counterOffer(sellerToken, body.offer._id, 470);
      expect([400, 403]).toContain(rejectedAgain.status);
    });

    it('rejects countering a terminal-state offer (state rules preserved)', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await updateOffer(sellerToken, body.offer._id, 'rejected').expect(200);

      const res = await counterOffer(sellerToken, body.offer._id, 450).expect(400);
      expect(res.body.code).toBe('INVALID_TRANSITION');
    });
  });

  describe('GET /offers/:id', () => {
    it('lets the buyer view their own offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      const res = await request(app)
        .get(`/api/offers/${body.offer._id}`)
        .set('Authorization', `Bearer ${buyerToken}`)
        .expect(200);
      expect(res.body.offer._id).toBe(body.offer._id);
      expect(res.body.offer.amount).toBe(400);
    });

    it('lets the seller view the offer', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await request(app)
        .get(`/api/offers/${body.offer._id}`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);
    });

    it('forbids an unrelated third user', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      const res = await request(app)
        .get(`/api/offers/${body.offer._id}`)
        .set('Authorization', `Bearer ${thirdToken}`)
        .expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('returns 404 for an unknown offer', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      await request(app)
        .get(`/api/offers/${fakeId}`)
        .set('Authorization', `Bearer ${buyerToken}`)
        .expect(404);
    });
  });

  describe('Dedicated accept/reject endpoints stay seller-only', () => {
    it('accept endpoint rejects non-sellers', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await request(app)
        .post(`/api/offers/${body.offer._id}/accept`)
        .set('Authorization', `Bearer ${thirdToken}`)
        .expect(404); // not the seller -> no matching offer
      expect((await Offer.findById(body.offer._id)).status).toBe('pending');
    });

    it('accepts a countered offer via the dedicated endpoint (no stale 404)', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await counterOffer(sellerToken, body.offer._id, 450).expect(201);

      const res = await request(app)
        .post(`/api/offers/${body.offer._id}/accept`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);
      expect(res.body.offer.status).toBe('accepted');
    });

    it('rejects a countered offer via the dedicated endpoint (no stale 404)', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await counterOffer(sellerToken, body.offer._id, 450).expect(201);

      const res = await request(app)
        .post(`/api/offers/${body.offer._id}/reject`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);
      expect(res.body.offer.status).toBe('rejected');
    });

    it('reject endpoint only works once (state rules preserved)', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await request(app)
        .post(`/api/offers/${body.offer._id}/reject`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);
      // Already terminal — cannot reject again
      await request(app)
        .post(`/api/offers/${body.offer._id}/reject`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(404);
    });
  });

  describe('Terminal states reject further PUT transitions', () => {
    it('cannot transition an accepted offer anywhere', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await updateOffer(sellerToken, body.offer._id, 'accepted').expect(200);
      const res = await updateOffer(sellerToken, body.offer._id, 'rejected').expect(400);
      expect(res.body.code).toBe('INVALID_TRANSITION');
    });

    it('cannot transition a withdrawn offer anywhere', async () => {
      const { body } = await makeOffer(buyerToken).expect(201);
      await updateOffer(buyerToken, body.offer._id, 'withdrawn').expect(200);
      await updateOffer(buyerToken, body.offer._id, 'accepted').expect(400);
    });
  });
});
