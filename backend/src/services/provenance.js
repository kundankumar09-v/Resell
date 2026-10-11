/**
 * Provenance Service
 *
 * Physical-product identity hashing, hash-chained provenance events,
 * and chain verification. Generates events server-side only.
 *
 * Raw identifiers are normalized, hashed with HMAC-SHA256 keyed by
 * IDENTIFIER_HASH_SALT, and never stored, logged, or exposed. The salt
 * (SCRUM-3x) defeats rainbow-table / offline dictionary attacks against
 * identifier hashes — a bare SHA-256 of a known IMEI/serial is trivially
 * reversible. Records written before salting are migrated lazily: their
 * plain SHA-256 hash is still accepted on lookup (legacyHashIdentifier)
 * and upgraded in place to the salted form.
 */

const crypto = require('crypto');
const AppError = require('../utils/AppError');
const ProvenanceEvent = require('../models/ProvenanceEvent');

const GENESIS_HASH = 'GENESIS';

// Proof-of-possession verification codes are short-lived (24 hours)
const VERIFICATION_CODE_TTL_MS = 24 * 60 * 60 * 1000;

// Salt used to key identifier hashes. Read from IDENTIFIER_HASH_SALT;
// when the env var is absent a constant fallback keeps the service
// functional locally (developers running without a backend/.env still get
// salted, non-rainbowable hashes). The fallback is NOT a per-deployment
// secret — production must set IDENTIFIER_HASH_SALT explicitly. Changing
// the salt invalidates existing salted records (their hashes no longer
// resolve); the lazy legacy upgrade only covers pre-salt records.
const FALLBACK_IDENTIFIER_HASH_SALT =
  'resell-fallback-identifier-salt-change-me-in-production';
let warnedSaltFallback = false;
const getIdentifierHashSalt = () => {
  const salt = process.env.IDENTIFIER_HASH_SALT;
  if (!salt && !warnedSaltFallback) {
    warnedSaltFallback = true;
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '[provenance] IDENTIFIER_HASH_SALT not set — using the constant fallback salt. Set it in production.'
      );
    }
  }
  return salt || FALLBACK_IDENTIFIER_HASH_SALT;
};

// Category slug/name keywords eligible for identifier collection
const IDENTIFIER_CATEGORY_KEYWORDS = [
  'phone',
  'mobile',
  'laptop',
  'computer',
  'vehicle',
  'car',
  'motorbike',
  'camera',
  'console',
  'gaming',
  'tablet',
  'watch',
  'electronics',
];

/**
 * Normalize a raw identifier by type.
 * - imei:   digits only, exactly 15
 * - vin:    uppercase alphanumeric, exactly 17
 * - serial: uppercase alphanumeric, at least 4
 */
const normalizeIdentifier = (raw, identifierType) => {
  if (!raw || typeof raw !== 'string') {
    throw new AppError('Identifier is required', 400, 'IDENTIFIER_REQUIRED');
  }
  const cleaned = raw.replace(/[\s-_.]/g, '');
  const type = String(identifierType || '').toLowerCase();

  if (type === 'imei') {
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length !== 15) {
      throw new AppError('IMEI must be exactly 15 digits', 400, 'IDENTIFIER_INVALID');
    }
    return digits;
  }
  if (type === 'vin') {
    const alnum = cleaned.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (alnum.length !== 17) {
      throw new AppError('VIN must be exactly 17 characters', 400, 'IDENTIFIER_INVALID');
    }
    return alnum;
  }
  if (type === 'serial') {
    const alnum = cleaned.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (alnum.length < 4) {
      throw new AppError('Serial number must be at least 4 characters', 400, 'IDENTIFIER_INVALID');
    }
    return alnum;
  }
  throw new AppError('Unsupported identifier type', 400, 'IDENTIFIER_TYPE_INVALID');
};

/**
 * HMAC-SHA256 of the normalized identifier keyed by IDENTIFIER_HASH_SALT.
 * Raw value is never persisted. The salt makes identifier hashes immune to
 * precomputed rainbow tables for the (small, structured) IMEI/VIN/serial
 * space.
 */
const hashIdentifier = (raw, identifierType) => {
  const normalized = normalizeIdentifier(raw, identifierType);
  return crypto
    .createHmac('sha256', getIdentifierHashSalt())
    .update(normalized)
    .digest('hex');
};

/**
 * Legacy pre-salt SHA-256 identifier hash. Used only for lazy migration:
 * identityVerification falls back to this lookup for records created before
 * hashing was salted and upgrades them to the salted hash in place.
 */
const legacyHashIdentifier = (raw, identifierType) => {
  const normalized = normalizeIdentifier(raw, identifierType);
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

/**
 * Temporary verification code the seller must show beside the
 * physical product in the proof photo. Short-lived: expires after
 * VERIFICATION_CODE_TTL_MS. Returns { code, codeExpiresAt }.
 */
const issueVerificationCode = () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return { code, codeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS) };
};

/**
 * Constant-time string comparison to prevent code timing attacks.
 */
const safeCodeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/**
 * Whether a category is eligible for identifier collection.
 * Uses the explicit requiresIdentifier flag, falling back to
 * slug/name keyword matching.
 */
const isIdentifierEligible = async (category) => {
  if (!category) return false;
  const Category = require('../models/Category');
  const doc = await Category.findById(category).select('slug name requiresIdentifier').lean();
  if (!doc) return false;
  if (doc.requiresIdentifier) return true;
  const text = `${doc.slug || ''} ${doc.name || ''}`.toLowerCase();
  return IDENTIFIER_CATEGORY_KEYWORDS.some((kw) => text.includes(kw));
};

// Identifier types only make sense for certain categories: IMEI identifies
// phones, VIN identifies vehicles. Serial numbers are universal.
const PHONE_TYPE_KEYWORDS = ['phone', 'mobile', 'smartphone'];
const VEHICLE_TYPE_KEYWORDS = ['vehicle', 'car', 'motorbike', 'motorcycle', 'scooter'];

/**
 * Whether an identifierType is a sensible combination for the category.
 * Serial numbers are valid for every eligible category; IMEI requires a
 * phone-like category; VIN requires a vehicle-like category.
 */
const isIdentifierTypeValidForCategory = async (category, identifierType) => {
  if (!identifierType || identifierType === 'serial') return true;
  if (!['imei', 'vin'].includes(identifierType)) return false;
  const Category = require('../models/Category');
  const doc = await Category.findById(category).select('slug name').lean();
  if (!doc) return false;
  const text = `${doc.slug || ''} ${doc.name || ''}`.toLowerCase();
  const keywords = identifierType === 'imei' ? PHONE_TYPE_KEYWORDS : VEHICLE_TYPE_KEYWORDS;
  return keywords.some((kw) => text.includes(kw));
};

/**
 * Compute the chain hash for an event.
 * hash = SHA256(previousHash + eventType|ownerId|listingId|transactionId|timestamp)
 */
const computeEventHash = ({ previousHash, eventType, ownerId, listingId, transactionId, timestamp }) => {
  const data = `${previousHash}|${eventType}|${ownerId}|${listingId || ''}|${transactionId || ''}|${timestamp.toISOString()}`;
  return crypto.createHash('sha256').update(data).digest('hex');
};

/**
 * Create a provenance event, chained to the previous event.
 * Server-side only — never accept chain fields from clients.
 */
const createProvenanceEvent = async ({ productIdentityId, eventType, ownerId, listingId, transactionId }) => {
  const last = await ProvenanceEvent.findOne({ productIdentityId })
    .sort({ timestamp: -1, createdAt: -1 })
    .select('hash')
    .lean();

  const previousHash = last?.hash || GENESIS_HASH;
  const timestamp = new Date();
  const hash = computeEventHash({
    previousHash,
    eventType,
    ownerId,
    listingId,
    transactionId,
    timestamp,
  });

  return ProvenanceEvent.create({
    productIdentityId,
    eventType,
    ownerId,
    listingId: listingId || null,
    transactionId: transactionId || null,
    timestamp,
    previousHash,
    hash,
  });
};

/**
 * Verify the integrity of the provenance chain for an identity.
 * Returns { valid, eventCount, brokenAt }.
 */
const verifyProvenanceChain = async (productIdentityId) => {
  const events = await ProvenanceEvent.find({ productIdentityId })
    .sort({ timestamp: 1, createdAt: 1 })
    .lean();

  let previousHash = GENESIS_HASH;
  for (const event of events) {
    const expected = computeEventHash({
      previousHash,
      eventType: event.eventType,
      ownerId: event.ownerId ? event.ownerId.toString() : '',
      listingId: event.listingId ? event.listingId.toString() : '',
      transactionId: event.transactionId || '',
      timestamp: new Date(event.timestamp),
    });
    if (expected !== event.hash || event.previousHash !== previousHash) {
      return { valid: false, eventCount: events.length, brokenAt: event._id.toString() };
    }
    previousHash = event.hash;
  }

  return { valid: true, eventCount: events.length, brokenAt: null };
};

module.exports = {
  GENESIS_HASH,
  VERIFICATION_CODE_TTL_MS,
  IDENTIFIER_CATEGORY_KEYWORDS,
  normalizeIdentifier,
  hashIdentifier,
  legacyHashIdentifier,
  issueVerificationCode,
  safeCodeEqual,
  generateVerificationCode: () => issueVerificationCode().code,
  isIdentifierEligible,
  isIdentifierTypeValidForCategory,
  computeEventHash,
  createProvenanceEvent,
  verifyProvenanceChain,
};
