import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

// No manual Authorization header needed — httpOnly cookies are sent automatically.

// ─── GET cache + in-flight request deduplication ───────────────────────────
const CACHE_TTL_MS = 60 * 1000;
const responseCache = new Map(); // cacheKey -> { data, timestamp }
const inflightRequests = new Map(); // cacheKey -> Promise

function getCacheKey(config) {
  return `${config.method?.toUpperCase()}:${config.url}?${JSON.stringify(config.params || {})}`;
}

/** Clear cached GET responses (call on logout or after mutating actions). */
export function clearApiCache() {
  responseCache.clear();
  inflightRequests.clear();
}

// ─── Refresh token guard ────────────────────────────────────────────────────
const MAX_REFRESH_RETRIES = 3;
const RETRY_COUNT_KEY = 'auth_refresh_retries';

/**
 * Singleton promise for the in-flight refresh request.
 * All concurrent 401 responses will wait on this same promise instead of
 * each kicking off a separate /auth/refresh call (which caused the loop).
 */
let refreshPromise = null;

/** Redirect to /login and reset retry bookkeeping. */
function forceLogout() {
  sessionStorage.removeItem(RETRY_COUNT_KEY);
  refreshPromise = null;
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
  }
}

/** Attempt to refresh tokens once. Returns true on success, false on failure. */
async function attemptRefresh() {
  if (!refreshPromise) {
    refreshPromise = api
      .post('/auth/refresh')
      .then(() => {
        // Success — reset counter and release the singleton.
        sessionStorage.removeItem(RETRY_COUNT_KEY);
        refreshPromise = null;
        return true;
      })
      .catch((err) => {
        refreshPromise = null;
        throw err;
      });
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const originalRequest = err.config;
    const status = err.response?.status;
    const errorCode = err.response?.data?.code;

    // Don't intercept refresh endpoint itself or login/register pages.
    const isRefreshEndpoint = originalRequest?.url?.includes('/auth/refresh');
    const isAuthPage =
      window.location.pathname.startsWith('/login') ||
      window.location.pathname.startsWith('/register');

    if (status === 401 && !originalRequest._retry && !isRefreshEndpoint && !isAuthPage) {
      // If the server tells us the refresh token is missing or invalid, no
      // point retrying. A missing token just means the visitor isn't logged in —
      // resolve to user = null without hijacking them to /login. An invalid
      // (expired/tampered) token is cleared by the backend; also no redirect.
      if (
        errorCode === 'REFRESH_TOKEN_MISSING' ||
        errorCode === 'REFRESH_TOKEN_INVALID'
      ) {
        sessionStorage.removeItem(RETRY_COUNT_KEY);
        return Promise.reject(err);
      }

      // Check retry counter.
      const retries = parseInt(sessionStorage.getItem(RETRY_COUNT_KEY) || '0', 10);
      if (retries >= MAX_REFRESH_RETRIES) {
        forceLogout();
        return Promise.reject(err);
      }

      // Increment counter before attempting refresh.
      sessionStorage.setItem(RETRY_COUNT_KEY, String(retries + 1));
      originalRequest._retry = true;

      try {
        await attemptRefresh();
        // Retry the original request — new access_token cookie is now set.
        return api(originalRequest);
      } catch {
        // Refresh failed — if we've now hit the limit, force logout.
        const currentRetries = parseInt(
          sessionStorage.getItem(RETRY_COUNT_KEY) || '0',
          10
        );
        if (currentRetries >= MAX_REFRESH_RETRIES) {
          forceLogout();
        }
        return Promise.reject(err);
      }
    }

    return Promise.reject(err);
  }
);

export default api;

// ─── Cached/deduplicated api.get wrapper ───────────────────────────────────
const rawGet = api.get.bind(api);

api.get = function get(url, config = {}) {
  if (config._noCache) return rawGet(url, config);

  const cacheKey = getCacheKey({ ...config, url, method: 'get' });
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return Promise.resolve(cached.response);
  }
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const promise = rawGet(url, config)
    .then((res) => {
      responseCache.set(cacheKey, { response: res, timestamp: Date.now() });
      return res;
    })
    .finally(() => {
      inflightRequests.delete(cacheKey);
    });
  inflightRequests.set(cacheKey, promise);
  return promise;
};

