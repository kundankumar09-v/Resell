/**
 * Text similarity helpers for near-duplicate description detection.
 *
 * Two independent, deliberately simple methods are exposed:
 *
 *  1. `charNgramJaccard` — character 3-gram Jaccard overlap. Pure JS, zero
 *     dependencies, always available (the fallback used when the ML service is
 *     unreachable). It is a *lexical* heuristic: two descriptions that share a
 *     lot of character sequences score high; a full rephrase scores low.
 *
 *  2. `cosineSimilarity` over CLIP text embeddings from the ML service
 *     (`POST /text-embed`). This is a frozen, general-purpose text encoder —
 *     it captures some semantics the n-gram method misses, but it is NOT a
 *     fraud-specific model and has no notion of scam intent.
 *
 * Honest labeling: neither method "understands" the listing. Both are cheap
 * similarity measures used to catch the copy-paste-then-tweak-2-words evasion
 * of the exact-match check. A determined fraudster changing the whole sentence
 * structure evades both (README §7.9).
 */

/** Lowercase + collapse all whitespace so formatting differences don't score. */
const normalizeText = (text) =>
  String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Set of (overlapping) character n-grams for a normalized string.
 * Returns an empty set for an empty string.
 */
const charNgrams = (text, n = 3) => {
  const normalized = normalizeText(text);
  const grams = new Set();
  if (!normalized) return grams;
  // Strings shorter than n still produce a single gram of the whole string so
  // two short-but-different words never both collapse to the empty set.
  if (normalized.length < n) {
    grams.add(normalized);
    return grams;
  }
  for (let i = 0; i + n <= normalized.length; i++) {
    grams.add(normalized.slice(i, i + n));
  }
  return grams;
};

/**
 * Character n-gram Jaccard similarity in [0, 1].
 * Both empty -> 1 (identical); one empty -> 0 (nothing in common).
 */
const charNgramJaccard = (a, b, n = 3) => {
  const setA = charNgrams(a, n);
  const setB = charNgrams(b, n);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * Cosine similarity of two numeric vectors. Returns null when the inputs are
 * missing/mismatched/non-finite or when either vector has zero magnitude, so
 * callers can fall back to n-gram similarity instead of treating "no verdict"
 * as "not similar".
 */
const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return null;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return null;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
};

module.exports = {
  normalizeText,
  charNgrams,
  charNgramJaccard,
  cosineSimilarity,
};
