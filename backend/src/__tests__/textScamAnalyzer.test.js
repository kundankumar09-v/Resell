/**
 * Scam-text pattern analyzer — unit tests.
 *
 * These are pure-function tests (no DB, no network). They document the exact
 * signal thresholds AND the honest limits of the lexical approach: benign
 * "urgent sale" prose must NOT score, while the copy-pasted scam template does.
 */

const {
  analyzeTextScam,
  MAX_CONTRIBUTION,
  TEXT_SCAM_SIGNALS,
} = require('../services/textScamAnalyzer');

describe('textScamAnalyzer.analyzeTextScam', () => {
  it('returns 0 for a clean listing', () => {
    const result = analyzeTextScam({
      title: 'iPhone 13 128GB',
      description: 'Genuine phone in good condition, comes with the original box.',
    });
    expect(result.score).toBe(0);
    expect(result.factors).toHaveLength(0);
    expect(result.signals).toHaveLength(0);
  });

  it('does not flag a legitimate single urgency phrase', () => {
    // One cliché is well below the >= 2 threshold — normal marketplace prose.
    const result = analyzeTextScam({
      title: 'Sofa for sale',
      description: 'urgent sale of sofa due to moving',
    });
    expect(result.score).toBe(0);
    expect(result.signals).not.toContain(TEXT_SCAM_SIGNALS.URGENCY);
  });

  it('flags a scam template and caps the contribution', () => {
    const result = analyzeTextScam({
      title: 'URGENT SALE',
      description: 'need cash today!!! CALL 9876543210',
    });
    // Contact (+10) + urgency (+10) + excessive caps (+5) = 25 = the cap.
    expect(result.score).toBe(25);
    expect(result.score).toBeLessThanOrEqual(MAX_CONTRIBUTION);
    expect(result.signals).toEqual(
      expect.arrayContaining([
        TEXT_SCAM_SIGNALS.CONTACT_INFO,
        TEXT_SCAM_SIGNALS.URGENCY,
        TEXT_SCAM_SIGNALS.CAPS,
      ])
    );
    expect(result.signals.length).toBeGreaterThanOrEqual(3);
  });

  it('caps the raw sum at MAX_CONTRIBUTION and reports it', () => {
    const result = analyzeTextScam({
      title: 'URGENT SALE',
      description:
        "need cash!!! moving abroad, last date, advance payment, don't miss, guaranteed, trust me!!! WhatsApp 9876543210 email pay@x.com",
      price: 100,
      originalPrice: 1000, // 10% of original -> lowball interaction
    });
    expect(result.rawScore).toBeGreaterThan(MAX_CONTRIBUTION);
    expect(result.capped).toBe(true);
    expect(result.score).toBe(MAX_CONTRIBUTION);
    expect(result.signals).toEqual(
      expect.arrayContaining([
        TEXT_SCAM_SIGNALS.CONTACT_INFO,
        TEXT_SCAM_SIGNALS.URGENCY,
        TEXT_SCAM_SIGNALS.PUNCTUATION,
        TEXT_SCAM_SIGNALS.LOWBALL_URGENCY,
      ])
    );
  });

  it('detects off-platform contact info in each form', () => {
    const email = analyzeTextScam({ description: 'Message me at seller.contact@gmail.com please' });
    expect(email.signals).toContain(TEXT_SCAM_SIGNALS.CONTACT_INFO);

    const whatsapp = analyzeTextScam({ description: 'Serious buyers only, WhatsApp me on the number in my profile' });
    expect(whatsapp.signals).toContain(TEXT_SCAM_SIGNALS.CONTACT_INFO);

    const phone = analyzeTextScam({ description: 'Call or text 9876543210 anytime' });
    expect(phone.signals).toContain(TEXT_SCAM_SIGNALS.CONTACT_INFO);
  });

  it('only fires LOWBALL_URGENCY_COMBO below 40% of the original price', () => {
    const justAbove = analyzeTextScam({
      title: 'iPhone — urgent sale',
      description: 'need to sell fast',
      price: 400,
      originalPrice: 1000, // exactly 40% -> not "lowball"
    });
    expect(justAbove.signals).not.toContain(TEXT_SCAM_SIGNALS.LOWBALL_URGENCY);

    const below = analyzeTextScam({
      title: 'iPhone — urgent sale',
      description: 'need to sell fast',
      price: 399,
      originalPrice: 1000, // 39.9% -> combo
    });
    expect(below.signals).toContain(TEXT_SCAM_SIGNALS.LOWBALL_URGENCY);
    expect(below.score).toBeGreaterThanOrEqual(15);
  });

  it('requires > 5 exclamation marks for the punctuation signal', () => {
    const five = analyzeTextScam({ title: 'Item', description: 'Buy now!!!!!' });
    expect(five.signals).not.toContain(TEXT_SCAM_SIGNALS.PUNCTUATION);

    const six = analyzeTextScam({ title: 'Item', description: 'Buy now!!!!!!' });
    expect(six.signals).toContain(TEXT_SCAM_SIGNALS.PUNCTUATION);
  });

  it('is resilient to missing/!string input', () => {
    expect(analyzeTextScam().score).toBe(0);
    expect(analyzeTextScam({ title: null, description: undefined }).score).toBe(0);
  });
});
