/**
 * DupDetect v2 HTTP Client — talks to the new FastAPI dupdetect service
 * (ml-service/pipeline/dupdetect/api.py, own port, default 8100).
 *
 * SHADOW MODE (default): verdicts are LOG-ONLY. Nothing here can block,
 * flag, or reject a listing. Set DUPDETECT_SHADOW=false to enforce later,
 * after shadow-log agreement with the legacy pipeline is proven.
 *
 * Fail-open contract: if the v2 service is down, slow, or returns garbage,
 * every function resolves to null and the caller moves on — the listing
 * flow never depends on this service.
 */

const axios = require('axios');

const DUPDETECT_SERVICE_URL = process.env.DUPDETECT_SERVICE_URL || 'http://localhost:8100';
const DUPDETECT_SHADOW = String(process.env.DUPDETECT_SHADOW || 'true') !== 'false';
const DEFAULT_TIMEOUT = Number(process.env.DUPDETECT_TIMEOUT_MS || 15000);

const client = axios.create({
  baseURL: DUPDETECT_SERVICE_URL,
  timeout: DEFAULT_TIMEOUT,
  headers: { 'Content-Type': 'application/json' },
});

function shadowTag() {
  return DUPDETECT_SHADOW ? 'SHADOW' : 'ENFORCE';
}

/**
 * Query the v2 pipeline for duplicates (cross-seller photo theft, tombstone
 * reposts, stolen text). `imageBuffer` = raw bytes of the cover image.
 * Resolves to the service verdict {decision, score, match, reasons} or null.
 */
async function queryDuplicate({ listingId, sellerId, imageBuffer, title = '', description = '' }) {
  if (!imageBuffer) return null;
  try {
    const res = await client.post('/dup/query', {
      listing_id: listingId ? String(listingId) : `q_${Date.now()}`,
      seller_id: String(sellerId || ''),
      image_b64: Buffer.from(imageBuffer).toString('base64'),
      title: title || '',
      description: description || '',
    });
    return res.data || null;
  } catch (err) {
    console.warn(`[DupClient] query failed for ${listingId || 'n/a'}: ${err.message}`);
    return null;
  }
}

/** Register a listing in the v2 store (called after the worker finishes analysis). */
async function addListing({ listingId, sellerId, imageBuffer, title = '', description = '' }) {
  if (!listingId || !sellerId || !imageBuffer) return null;
  try {
    const res = await client.post('/dup/add', {
      listing_id: String(listingId),
      seller_id: String(sellerId),
      image_b64: Buffer.from(imageBuffer).toString('base64'),
      title: title || '',
      description: description || '',
    });
    return res.data || null;
  } catch (err) {
    console.warn(`[DupClient] add failed for ${listingId}: ${err.message}`);
    return null;
  }
}

/** Tombstone a removed listing so delete-and-repost keeps getting caught. */
async function deleteListing(listingId) {
  if (!listingId) return null;
  try {
    const res = await client.post('/dup/delete', { listing_id: String(listingId) });
    return res.data || null;
  } catch (err) {
    console.warn(`[DupClient] delete failed for ${listingId}: ${err.message}`);
    return null;
  }
}

/**
 * Structured shadow log: one line per verdict, beside the legacy decision.
 * Log-only by design — nothing here mutates the product document.
 */
function logShadowVerdict(productId, verdict, extra = {}) {
  if (!verdict) return;
  console.log(
    `[DupClient][${shadowTag()}] product=${productId} decision=${verdict.decision} ` +
    `score=${verdict.score} match=${verdict.match || '-'} ` +
    `reasons=${JSON.stringify(verdict.reasons || [])} legacy=${extra.legacy || 'n/a'}`
  );
}

async function checkHealth() {
  try {
    const res = await client.get('/health', { timeout: 3000 });
    return Boolean(res.data);
  } catch {
    return false;
  }
}

module.exports = {
  DUPDETECT_SERVICE_URL,
  DUPDETECT_SHADOW,
  queryDuplicate,
  addListing,
  deleteListing,
  logShadowVerdict,
  checkHealth,
};
