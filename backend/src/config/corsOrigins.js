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

/**
 * Normalize one CLIENT_URL entry into a canonical origin.
 *
 * Handles the mistakes that are easy to make in a .env file:
 *  - surrounding whitespace            -> trimmed
 *  - trailing slash(es)                -> stripped (an Origin header never has one)
 *  - casing / default ports            -> canonicalised by `new URL()`
 *
 * Returns the canonical origin string, or `null` if the entry is blank or not
 * a valid absolute http(s) URL. Invalid entries are logged (never thrown) so a
 * typo degrades to a smaller allowlist instead of crashing the process.
 */
const normalizeOrigin = (entry) => {
  const raw = String(entry == null ? '' : entry).trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw.replace(/\/+$/, ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.error(
        `[Config] Ignoring CLIENT_URL entry "${raw}" — only http/https origins are allowed (got "${parsed.protocol}")`
      );
      return null;
    }
    // `parsed.origin` is already canonical: lowercased host, no trailing
    // slash, default port dropped. Any path/query is intentionally discarded —
    // CORS origins cannot contain one.
    return parsed.origin;
  } catch {
    console.error(
      `[Config] Ignoring invalid CLIENT_URL entry "${raw}" — expected an absolute origin such as "http://localhost:3000"`
    );
    return null;
  }
};

const parseOrigins = () => {
  const configured = process.env.CLIENT_URL;
  // Unset, empty or whitespace-only -> fall back to the local dev default.
  if (!configured || !configured.trim()) return [DEFAULT_ORIGIN];

  const origins = [];
  for (const entry of configured.split(',')) {
    const origin = normalizeOrigin(entry);
    if (origin && !origins.includes(origin)) origins.push(origin);
  }

  if (origins.length === 0) {
    console.error(
      `[Config] CLIENT_URL="${configured}" contained no valid origin — falling back to ${DEFAULT_ORIGIN}`
    );
    return [DEFAULT_ORIGIN];
  }
  return origins;
};

// Never let a malformed CLIENT_URL take the whole boot down: this module is
// required at startup, so any throw here would surface as a silent crash.
const resolveOrigins = () => {
  try {
    return parseOrigins();
  } catch (err) {
    console.error(
      `[Config] Failed to parse CLIENT_URL (${err.message}) — falling back to ${DEFAULT_ORIGIN}`
    );
    return [DEFAULT_ORIGIN];
  }
};

const CLIENT_ORIGINS = resolveOrigins();

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