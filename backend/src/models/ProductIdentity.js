const mongoose = require('mongoose');

/**
 * ProductIdentity - physical-product ownership registry.
 *
 * Stores ONLY a SHA-256 hash of the serial number / IMEI / VIN.
 * The raw identifier is never persisted, logged, or exposed.
 */
const productIdentitySchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    identifierType: {
      type: String,
      // 'visual': possession-based identity for products without any
      // standardized identifier (SCRUM-25). The hash is derived from the
      // listing id itself — no sensitive identifier is involved.
      enum: ['imei', 'serial', 'vin', 'visual'],
      required: true,
    },
    identifierHash: {
      type: String,
      required: true,
    },
    currentOwnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'sold', 'flagged', 'reported_stolen'],
      default: 'active',
    },
    // Proof-of-possession (supporting signal, not proof of ownership).
    // The seller photographs the physical product beside a short-lived
    // verification code and submits the code — no OCR involved.
    verification: {
      proofPhotoUrl: { type: String, default: '' },
      verificationCode: { type: String, default: '' },
      codeExpiresAt: { type: Date, default: null },
      method: { type: String, enum: ['none', 'photo_code', 'ocr'], default: 'none' },
      // VERIFIED / FAILED / UNVERIFIED — never fraud on its own when missing
      possessionStatus: {
        type: String,
        enum: ['unverified', 'verified', 'failed'],
        default: 'unverified',
      },
      verifiedAt: { type: Date, default: null },
      attempts: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true }
);

// One identity per physical product identifier
productIdentitySchema.index({ identifierType: 1, identifierHash: 1 }, { unique: true });
productIdentitySchema.index({ currentOwnerId: 1 });
productIdentitySchema.index({ status: 1 });

module.exports = mongoose.model('ProductIdentity', productIdentitySchema);
