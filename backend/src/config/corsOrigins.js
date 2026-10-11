/**
 * Single source of truth for the allowed frontend origins.
 *
 * CLIENT_URL is a comma-separated allowlist of permitted origins
 * (e.g. "http://localhost:3000,http://localhost:3001"). Express CORS, the
 * Socket.IO handshake, the CSP connect-src, Stripe redirect URLs and the
 * cookie sameSite decision all derive from this one list so they can never
 * drift apart.
 *
 * Strict by design: only exact origins listed here are allowed — no
 * wildcards, no origin-reflecting, no "allow everything when unset".
 *
 * NOTE: dotenv must already have loaded CLIENT_URL before this module is
 * required (server.js requires it after dotenv.config()).
 */
const DEFAULT_ORIGIN = 'http://localhost:3000';

const parseOrigins = () =>
  (process.env.CLIENT_URL || DEFAULT_ORIGIN)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const CLIENT_ORIGINS = parseOrigins();

// True when the request Origin is one of the allowed origins. The absence of
// an Origin header (non-browser clients: server-to-server, CLI tools) is
// allowed, matching the behavior of both the express `cors` middleware and
// engine.io's handshake handling.
const isOriginAllowed = (origin) => !origin || CLIENT_ORIGINS.includes(origin);

// First allowed origin — used where a single concrete origin is required
// (Stripe success/cancel URLs, cookie sameSite hostname comparison) and a
// comma-separated list would be meaningless.
const FIRST_CLIENT_ORIGIN = CLIENT_ORIGINS[0] || DEFAULT_ORIGIN;

module.exports = { CLIENT_ORIGINS, FIRST_CLIENT_ORIGIN, DEFAULT_ORIGIN, isOriginAllowed };