const jwt = require('jsonwebtoken');

const crypto = require('crypto');

const { FIRST_CLIENT_ORIGIN } = require('../config/corsOrigins');

// Access and refresh tokens have separate lifetimes:
//   - access:  short (default 15m) — reduces the blast radius of a leaked token
//   - refresh: long  (default 7d)  — used only by /api/auth/refresh
// JWT_EXPIRE is still honored as a backward-compatible fallback for the access
// token so existing deployments that set only JWT_EXPIRE keep working.
const accessExpire = () =>
  process.env.JWT_ACCESS_EXPIRE || process.env.JWT_EXPIRE || '15m';
const refreshExpire = () => process.env.JWT_REFRESH_EXPIRE || '7d';

// Parse a jsonwebtoken-style duration ("15m", "7d", "3600s") to milliseconds
// so the cookie Max-Age stays in lockstep with the token lifetime.
const parseDurationMs = (value, fallbackMs) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = /^(\d+)\s*([smhd])$/.exec(String(value || '').trim());
  if (!match) return fallbackMs;
  const unit = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2]];
  return Number(match[1]) * unit;
};

const generateToken = (payload) => {
  return jwt.sign({ ...payload, jti: crypto.randomUUID() }, process.env.JWT_SECRET, {
    expiresIn: accessExpire(),
  });
};

const generateRefreshToken = (payload) => {
  return jwt.sign({ ...payload, jti: crypto.randomUUID() }, process.env.JWT_SECRET, {
    expiresIn: refreshExpire(),
  });
};

const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

/**
 * Set auth tokens as httpOnly cookies on the response.
 * - access_token: short-lived, readable by the server for auth
 * - refresh_token: long-lived, used only by the /refresh endpoint
 */
const setTokenCookies = (res, accessToken, refreshToken) => {
  const isProduction = process.env.NODE_ENV === 'production';
  // First entry of the CORS allowlist — the single concrete origin used for
  // the sameSite hostname comparison. All listed origins share the same
  // deployment host by construction, so comparing ports is irrelevant.
  const clientUrl = FIRST_CLIENT_ORIGIN;
  // Determine sameSite based on whether CLIENT_URL is on a different *domain*.
  // Comparing full origins (including port) is wrong — localhost:3000 and
  // localhost:5000 are same-site.  Only different hostnames (e.g. example.com
  // vs api.example.com) should use 'none'.  SameSite=None also requires
  // Secure=true, which we don't set in development, so using it there would
  // cause browsers to silently drop the cookie entirely.
  let sameSite = 'lax';
  try {
    const clientHost = new URL(clientUrl).hostname;
    const serverHost = new URL(`http://localhost:${process.env.PORT || 5000}`).hostname;
    if (clientHost !== serverHost) sameSite = 'none';
  } catch { /* ignore */ }

  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite,
    maxAge: parseDurationMs(accessExpire(), 15 * 60 * 1000), // matches token TTL
    path: '/',
  });

  if (refreshToken) {
    // Set refresh token cookie on root path so it is sent with /api/auth/refresh requests.
  // Using '/' broadens scope but simplifies token refresh flow.
  res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite,
      maxAge: parseDurationMs(refreshExpire(), 7 * 24 * 60 * 60 * 1000), // matches token TTL
      path: '/',
    });
  }
};

const clearTokenCookies = (res) => {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/' }); // must match the path set in setTokenCookies
};

module.exports = {
  generateToken,
  generateRefreshToken,
  verifyToken,
  setTokenCookies,
  clearTokenCookies,
};
