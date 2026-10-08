// Shared server-side limits — one source of truth consumed by validation
// middleware and controllers. Environment variables (wired in
// config/validateEnv.js) override these defaults at runtime.
const MIN_IMAGES = 3;
const MAX_IMAGES = 8;
const DUPLICATE_HASH_THRESHOLD = 12;

module.exports = { MIN_IMAGES, MAX_IMAGES, DUPLICATE_HASH_THRESHOLD };
