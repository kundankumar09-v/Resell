// Shared server-side limits — one source of truth consumed by validation
// middleware and controllers. Environment variables (wired in
// config/validateEnv.js) override these defaults at runtime.
const MIN_IMAGES = 3;
const MAX_IMAGES = 8;
// Same pHash Hamming-distance threshold as fraudDetection.js
// HASH_SIMILARITY_THRESHOLD — both consume the single
// HASH_SIMILARITY_THRESHOLD env var (default 12).
const DUPLICATE_HASH_THRESHOLD =
  Number(process.env.HASH_SIMILARITY_THRESHOLD) || 12;

module.exports = { MIN_IMAGES, MAX_IMAGES, DUPLICATE_HASH_THRESHOLD };
