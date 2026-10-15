/**
 * Scam-Text Pattern Analyzer
 *
 * HONESTY NOTE — read before trusting any output:
 * This is a *lexical* heuristic (keywords + regexes), not a learned model.
 * It does not understand the listing and has no notion of intent. Fraudsters
 * can trivially rewrite a scam to avoid every rule below. Its purpose is to
 * catch the low-effort, copy-pasted marketplace scam template and to express
 * the urgency + lowball *interaction* that the linear v1 scorer cannot encode.
 * Roadmap: replace/augment with text embeddings once labeled scam text exists
 * (see README §7.10).
 *
 * Output contract (pure, no I/O):
 *   { score, rawScore, capped, factors: [String], signals: [String] }
 * `score` is capped at MAX_CONTRIBUTION; `rawScore` is the uncapped sum.
 */

// Cap on how much the text-scam block may add to the overall v1 risk score.
// Kept deliberately low so a suspicious *description* can never flag a listing
// on its own (it is one supporting block among several).
const MAX_CONTRIBUTION = 25;

// Recurring urgency / pressure phrases from the copy-pasted scam template.
// Case-insensitive substring match against the normalized title + description.
const URGENCY_PHRASES = [
  'urgent sale',
  'need cash',
  'moving abroad',
  'last date',
  'today only',
  'immediate sale',
  "don't miss",
  'dont miss',
  'advance payment',
  'pay advance',
  'trust me',
  'guaranteed',
];

const SIGNAL = {
  CONTACT_INFO: 'SUSPICIOUS_CONTACT_INFO',
  URGENCY: 'URGENCY_PRESSURE_PHRASES',
  CAPS: 'EXCESSIVE_CAPS',
  PUNCTUATION: 'EXCESSIVE_PUNCTUATION',
  LOWBALL_URGENCY: 'LOWBALL_URGENCY_COMBO',
};

// Off-platform contact = the #1 scam vector (payment leaves the platform and
// has no buyer protection). Detected with simple regexes, not NLP.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const WHATSAPP_RE = /\bwhats?\s?app\b|\bwa\s+me\b/i;
// Indian mobile: optional +91 / 0 prefix, then a 10-digit number starting 6-9.
const INDIA_MOBILE_RE = /(?:\+?91[\s.-]?|0)?[6-9]\d{9}\b/;
// Generic 10-digit run (covers non-Indian numbers the India pattern misses).
const GENERIC_PHONE_RE = /\b\d{10}\b/;

const analyzeTextScam = ({ title = '', description = '', price, originalPrice } = {}) => {
  const text = `${title == null ? '' : title} ${description == null ? '' : description}`.trim();
  const lower = text.toLowerCase();
  const factors = [];
  const signals = [];
  let rawScore = 0;

  // 1. Contact-info shilling — regex
  const contacts = [];
  if (INDIA_MOBILE_RE.test(text)) {
    contacts.push('phone number');
  } else if (GENERIC_PHONE_RE.test(text)) {
    contacts.push('10-digit number');
  }
  if (EMAIL_RE.test(text)) contacts.push('email address');
  if (WHATSAPP_RE.test(text)) contacts.push('WhatsApp / messaging app');
  if (contacts.length > 0) {
    signals.push(SIGNAL.CONTACT_INFO);
    rawScore += 10;
    factors.push(
      `Contact information in listing text (${contacts.join(', ')}) — off-platform payment is the top scam vector`
    );
  }

  // 2. Urgency / cliché pressure phrases — keyword count
  const matchedPhrases = URGENCY_PHRASES.filter((phrase) => lower.includes(phrase));
  if (matchedPhrases.length >= 4) {
    signals.push(SIGNAL.URGENCY);
    rawScore += 15;
    factors.push(
      `Heavy urgency/pressure language (${matchedPhrases.length} clichés): "${matchedPhrases
        .slice(0, 4)
        .join('", "')}"`
    );
  } else if (matchedPhrases.length >= 2) {
    signals.push(SIGNAL.URGENCY);
    rawScore += 10;
    factors.push(
      `Urgency/pressure language (${matchedPhrases.length} clichés): "${matchedPhrases.join('", "')}"`
    );
  }

  // 3. Formatting abuse
  const letters = text.replace(/[^a-z]/gi, '');
  const caps = text.replace(/[^A-Z]/g, '');
  if (text.length > 30 && letters.length > 0 && caps.length / letters.length > 0.5) {
    signals.push(SIGNAL.CAPS);
    rawScore += 5;
    factors.push(
      `Excessive capitalization (${Math.round((caps.length / letters.length) * 100)}% of letters uppercased)`
    );
  }
  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations > 5) {
    signals.push(SIGNAL.PUNCTUATION);
    rawScore += 5;
    factors.push(`Excessive punctuation (${exclamations} exclamation marks)`);
  }

  // 4. Price-pressure interaction signal.
  //    This is the kind of rule the linear v1 scorer cannot express: neither
  //    "urgent" nor a low price is suspicious alone, but an urgent sale at
  //    <40% of MSRP is the classic "get money out of the buyer fast" pattern.
  const priceNum = Number(price);
  const originalNum = Number(originalPrice);
  if (
    /\burgent\b/i.test(lower) &&
    Number.isFinite(priceNum) &&
    priceNum > 0 &&
    Number.isFinite(originalNum) &&
    originalNum > 0 &&
    priceNum < 0.4 * originalNum
  ) {
    signals.push(SIGNAL.LOWBALL_URGENCY);
    rawScore += 15;
    factors.push(
      `Lowball price combined with urgency language (${priceNum} is ${Math.round(
        (priceNum / originalNum) * 100
      )}% of original)`
    );
  }

  const score = Math.min(rawScore, MAX_CONTRIBUTION);

  return {
    score,
    rawScore,
    capped: rawScore > MAX_CONTRIBUTION,
    factors,
    signals,
  };
};

module.exports = {
  analyzeTextScam,
  MAX_CONTRIBUTION,
  URGENCY_PHRASES,
  TEXT_SCAM_SIGNALS: SIGNAL,
};
