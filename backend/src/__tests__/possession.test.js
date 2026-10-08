const request = require('supertest');
const mongoose = require('mongoose');
const { app, server } = require('../server');
const User = require('../models/User');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const Report = require('../models/Report');
const AuditLog = require('../models/AuditLog');
const ProductIdentity = require('../models/ProductIdentity');
const ProvenanceEvent = require('../models/ProvenanceEvent');

const extractToken = (res) => {
  const setCookie = res.headers['set-cookie'] || [];
  const c = setCookie.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0].split('=')[1] : null;
};

const RAW_IMEI = '356938035643809';
const PROOF_URL = 'https://example.com/proof.jpg';

const createUserAndLogin = async (name, role = 'seller') => {
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


// Minimum 3 images (multi-angle requirement): the given first image plus two
// padding images whose hashes are pairwise >13 hamming distance from every
// fixture hash in this suite (verified computationally).
const threeImages = (first) => [
  first,
  { url: 'https://example.com/pad-1.jpg', publicId: 'pad-1', hash: 'c42a171d4bccc04d' },
  { url: 'https://example.com/pad-2.jpg', publicId: 'pad-2', hash: '840074e0679d14f1' },
];
describe('Proof of Possession & Stolen Product Integration', () => {
  let categoryId;
  let seller;
  let sellerToken;
  let otherSeller;
  let otherSellerToken;
  let admin;
  let adminToken;

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
    const category = await Category.create({
      name: `Phones ${Date.now()}`,
      slug: `phones-${Date.now()}`,
      icon: 'package',
    });
    categoryId = category._id.toString();

    ({ user: seller, token: sellerToken } = await createUserAndLogin('Owner Seller'));
    ({ user: otherSeller, token: otherSellerToken } = await createUserAndLogin('Other Seller'));
    ({ user: admin, token: adminToken } = await createUserAndLogin('Admin User', 'admin'));
  });

  const createListing = (token, overrides = {}) =>
    request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'iPhone 14 Pro',
        description: 'Great condition phone',
        price: 800,
        category: categoryId,
        brand: 'Apple',
        condition: 'good',
        images: threeImages({ url: 'https://example.com/img.jpg', publicId: 'img', hash: 'aabbccdd11223344' }),
        specifications: [],
        identifier: RAW_IMEI,
        identifierType: 'imei',
        ...overrides,
      });

  const createTrackedListing = async () => {
    const res = await createListing(sellerToken).expect(201);
    return {
      productId: res.body.product._id,
      code: res.body.identityStatus.verification.verificationCode,
      expiresAt: res.body.identityStatus.verification.codeExpiresAt,
    };
  };

  const submitPossession = (token, productId, code) =>
    request(app)
      .post(`/api/products/${productId}/identity/verify-possession`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code, proofImageUrl: PROOF_URL });

  describe('Verification code lifecycle', () => {
    it('issues a short-lived code at registration', async () => {
      const { code, expiresAt } = await createTrackedListing();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
      // ~24h TTL
      expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    });

    it('accepts a valid code and marks possession VERIFIED', async () => {
      const { productId, code } = await createTrackedListing();

      const res = await submitPossession(sellerToken, productId, code).expect(200);
      expect(res.body.possessionStatus).toBe('verified');

      const identity = await ProductIdentity.findOne({ productId });
      expect(identity.verification.possessionStatus).toBe('verified');
      expect(identity.verification.method).toBe('photo_code');
      expect(identity.verification.verifiedAt).toBeTruthy();
      expect(identity.verification.proofPhotoUrl).toBe(PROOF_URL);

      // Provenance event recorded in the hash chain
      const event = await ProvenanceEvent.findOne({
        productIdentityId: identity._id,
        eventType: 'possession_verified',
      });
      expect(event).toBeTruthy();
      expect((await require('../services/provenance').verifyProvenanceChain(identity._id)).valid).toBe(true);
    });

    it('rejects an expired code and reissues a fresh one', async () => {
      const { productId, code } = await createTrackedListing();

      // Force expiry
      await ProductIdentity.updateOne(
        { productId },
        { $set: { 'verification.codeExpiresAt': new Date(Date.now() - 1000) } }
      );

      const res = await submitPossession(sellerToken, productId, code).expect(400);
      expect(res.body.code).toBe('VERIFICATION_CODE_EXPIRED');

      // A fresh code was issued; the old one no longer matches
      const identity = await ProductIdentity.findOne({ productId });
      expect(identity.verification.verificationCode).not.toBe(code);
      expect(identity.verification.possessionStatus).toBe('unverified');
      expect(identity.verification.attempts).toBe(0);

      // The fresh code works
      const res2 = await submitPossession(sellerToken, productId, identity.verification.verificationCode).expect(200);
      expect(res2.body.possessionStatus).toBe('verified');
    });

    it('marks possession FAILED on a wrong code without blocking the listing', async () => {
      const { productId } = await createTrackedListing();

      const res = await submitPossession(sellerToken, productId, 'WRONG1').expect(200);
      expect(res.body.possessionStatus).toBe('failed');
      expect(res.body.remainingAttempts).toBe(4);

      const identity = await ProductIdentity.findOne({ productId });
      expect(identity.verification.possessionStatus).toBe('failed');
      expect(identity.verification.attempts).toBe(1);
      // Listing itself is untouched â€” failed possession is a signal, not a block
      const product = await Product.findById(productId);
      expect(product.status).toBe('active');
    });

    it('locks out after too many failed attempts', async () => {
      const { productId } = await createTrackedListing();
      for (let i = 0; i < 5; i++) {
        await submitPossession(sellerToken, productId, 'WRONG1').expect(200);
      }
      const res = await submitPossession(sellerToken, productId, 'WRONG1').expect(429);
      expect(res.body.code).toBe('VERIFICATION_ATTEMPTS_EXCEEDED');
    });

    it('requires a proof photo and rejects non-owners', async () => {
      const { productId, code } = await createTrackedListing();

      const noPhoto = await request(app)
        .post(`/api/products/${productId}/identity/verify-possession`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .send({ code });
      expect(noPhoto.status).toBe(400);

      const notOwner = await submitPossession(otherSellerToken, productId, code);
      expect(notOwner.status).toBe(403);
      expect(notOwner.body.code).toBe('FORBIDDEN');
    });

    it('never treats missing verification alone as fraud', async () => {
      const res = await createListing(sellerToken).expect(201);
      // No possession verification submitted at all
      const assessment = res.body.product.aiAnalysis.riskAssessment;
      expect(assessment.riskLevel).toBe('low');
      expect(assessment.riskScore).toBe(0);
      expect(
        assessment.factors.some((f) =>
          f.toLowerCase().includes('possession')
        )
      ).toBe(false);
    });

    it('surfaces POSSESSION_VERIFICATION_FAILED as a supporting signal only', async () => {
      const { productId } = await createTrackedListing();
      await submitPossession(sellerToken, productId, 'WRONG1').expect(200);

      const res = await request(app).get(`/api/products/${productId}/identity`).expect(200);
      expect(res.body.verification.possessionStatus).toBe('failed');
      expect(res.body.signals).toContain('POSSESSION_VERIFICATION_FAILED');
      expect(res.body.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Stolen product integration (admin only)', () => {
    const markStolen = (token, identityId, body = {}) =>
      request(app)
        .put(`/api/admin/identities/${identityId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'reported_stolen', ...body });

    it('rejects unauthorized stolen-status updates', async () => {
      const { productId } = await createTrackedListing();
      const identity = await ProductIdentity.findOne({ productId });

      // Not logged in
      const anon = await request(app)
        .put(`/api/admin/identities/${identity._id}/status`)
        .send({ status: 'reported_stolen' });
      expect(anon.status).toBe(401);

      // Regular seller
      const res = await markStolen(sellerToken, identity._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');

      // Even the current owner cannot mark their own product stolen
      const owner = await markStolen(otherSellerToken, identity._id);
      expect(owner.status).toBe(403);

      const unchanged = await ProductIdentity.findById(identity._id);
      expect(unchanged.status).toBe('active');
    });

    it('admin can mark reported_stolen: creates provenance + audit events', async () => {
      const { productId } = await createTrackedListing();
      const identity = await ProductIdentity.findOne({ productId });

      const report = await Report.create({
        reporter: otherSeller._id,
        targetType: 'product',
        target: productId,
        reason: 'fraud',
        description: 'Stolen phone',
      });

      const res = await markStolen(adminToken, identity._id, { reportId: report._id, note: 'Police report verified' }).expect(200);
      expect(res.body.identity.status).toBe('reported_stolen');
      expect(res.body.identity.identifierType).toBe('imei');
      // Raw identifier / hash never exposed
      expect(JSON.stringify(res.body)).not.toContain(RAW_IMEI);
      expect(JSON.stringify(res.body)).not.toContain(identity.identifierHash);

      // Hash-chained 'reported' provenance event referencing the report
      const event = await ProvenanceEvent.findOne({
        productIdentityId: identity._id,
        eventType: 'reported',
      });
      expect(event).toBeTruthy();
      expect(event.transactionId).toBe(`report:${report._id}`);
      expect((await require('../services/provenance').verifyProvenanceChain(identity._id)).valid).toBe(true);

      // Audit log records the moderator action
      const audit = await AuditLog.findOne({ action: 'identity_status_update', target: identity._id });
      expect(audit).toBeTruthy();
      expect(audit.actor.toString()).toBe(admin._id.toString());
      expect(audit.metadata.status).toBe('reported_stolen');

      // Triggering Report is resolved
      const updatedReport = await Report.findById(report._id);
      expect(updatedReport.status).toBe('resolved');
      expect(updatedReport.reviewedBy.toString()).toBe(admin._id.toString());

      // Linked listing held by the moderation flow
      const product = await Product.findById(productId);
      expect(product.status).toBe('flagged');
      expect(product.isFlagged).toBe(true);
    });

    it('blocks future listings with a reported_stolen identifier', async () => {
      const { productId } = await createTrackedListing();
      const identity = await ProductIdentity.findOne({ productId });
      await markStolen(adminToken, identity._id).expect(200);

      const blocked = await createListing(sellerToken, {
        title: 'Try to relist stolen phone',
        images: threeImages({ url: 'https://example.com/img2.jpg', publicId: 'img2', hash: 'ffffffff00000001' }),
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('IDENTITY_BLOCKED');

      // A different seller is blocked too
      const blockedOther = await createListing(otherSellerToken, {
        title: 'Another seller tries the same IMEI',
        images: threeImages({ url: 'https://example.com/img3.jpg', publicId: 'img3', hash: 'ffffffff00000002' }),
      });
      expect(blockedOther.status).toBe(403);
      expect(blockedOther.body.code).toBe('IDENTITY_BLOCKED');
    });

    it('admin can restore an identity to active', async () => {
      const { productId } = await createTrackedListing();
      const identity = await ProductIdentity.findOne({ productId });
      await markStolen(adminToken, identity._id).expect(200);

      const res = await request(app)
        .put(`/api/admin/identities/${identity._id}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'active', note: 'False report' })
        .expect(200);
      expect(res.body.identity.status).toBe('active');

      // Owner can list again
      const relist = await createListing(sellerToken, {
        title: 'Relisted after false report',
        images: threeImages({ url: 'https://example.com/img4.jpg', publicId: 'img4', hash: 'ffffffff00000003' }),
      });
      expect(relist.status).toBe(201);
    });

    it('legitimate resale still works after all changes', async () => {
      const { productId } = await createTrackedListing();

      await Sale.create({
        product: productId,
        seller: seller._id,
        buyer: otherSeller._id,
        salePrice: 800,
        netAmount: 760,
        status: 'completed',
        paymentStatus: 'paid',
      });
      await request(app)
        .patch(`/api/products/${productId}/sold`)
        .set('Authorization', `Bearer ${sellerToken}`)
        .expect(200);

      const resale = await createListing(otherSellerToken, {
        title: 'Legit resale of same phone',
        images: threeImages({ url: 'https://example.com/img5.jpg', publicId: 'img5', hash: 'ffffffff00000004' }),
      }).expect(201);

      expect(resale.body.identityStatus.status).toBe('active');
      expect(resale.body.identityStatus.warnings).toHaveLength(0);
      expect(resale.body.product.aiAnalysis.riskAssessment.factors).not.toContainEqual(
        expect.stringContaining('different owner')
      );

      // New owner receives their own short-lived code for possession proof
      expect(resale.body.identityStatus.verification.possessionStatus).toBe('unverified');
      expect(resale.body.identityStatus.verification.verificationCode).toMatch(/^[A-Z2-9]{6}$/);
    });
  });
});
