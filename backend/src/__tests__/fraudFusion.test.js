/**
 * v1/v2 fraud score fusion policy — unit tests (pure, no DB).
 *
 * Policy (README §8.4):
 *   both v1 + v2 -> max(v1, round(v2*100)), fusionMode 'v1+v2-max'
 *   v1 only      -> v1 score,               fusionMode 'v1'
 *   v2 only      -> round(v2*100),          fusionMode 'v2'
 * max() is conservative: either engine can escalate, neither can downgrade.
 */

const { fuseFraudScores } = require('../services/fraudDetection');

describe('fuseFraudScores', () => {
  it('v1 only -> v1 score with fusionMode "v1"', () => {
    const result = fuseFraudScores({ v1RiskScore: 42 });
    expect(result).toEqual({
      riskScore: 42,
      riskLevel: 'medium',
      fusionMode: 'v1',
      v1RiskScore: 42,
      v2FraudProbability: null,
    });
  });

  it('v2 only -> round(probability*100) with fusionMode "v2"', () => {
    const result = fuseFraudScores({ v2FraudProbability: 0.834 });
    expect(result.riskScore).toBe(83);
    expect(result.riskLevel).toBe('high');
    expect(result.fusionMode).toBe('v2');
    expect(result.v1RiskScore).toBeNull();
    expect(result.v2FraudProbability).toBe(0.834);
  });

  it('both -> max(v1, round(v2*100)) with fusionMode "v1+v2-max"', () => {
    const v1Wins = fuseFraudScores({ v1RiskScore: 60, v2FraudProbability: 0.2 });
    expect(v1Wins.riskScore).toBe(60);
    expect(v1Wins.fusionMode).toBe('v1+v2-max');
    expect(v1Wins.v1RiskScore).toBe(60);
    expect(v1Wins.v2FraudProbability).toBe(0.2);

    // v2 can only raise the score, never lower it
    const v2Wins = fuseFraudScores({ v1RiskScore: 20, v2FraudProbability: 0.91 });
    expect(v2Wins.riskScore).toBe(91);
    expect(v2Wins.riskLevel).toBe('high');
    expect(v2Wins.fusionMode).toBe('v1+v2-max');
  });

  it('derives riskLevel from the fused score, not the v1 score', () => {
    // v1 is low (10) but v2 pushes the fused score into medium/high
    const medium = fuseFraudScores({ v1RiskScore: 10, v2FraudProbability: 0.3 });
    expect(medium.riskScore).toBe(30);
    expect(medium.riskLevel).toBe('medium');

    const high = fuseFraudScores({ v1RiskScore: 10, v2FraudProbability: 0.8 });
    expect(high.riskScore).toBe(80);
    expect(high.riskLevel).toBe('high');
  });

  it('falls back to a safe low/v1 result when neither score is present', () => {
    expect(fuseFraudScores()).toEqual({
      riskScore: 0,
      riskLevel: 'low',
      fusionMode: 'v1',
      v1RiskScore: null,
      v2FraudProbability: null,
    });
  });

  it('ignores non-finite inputs (treated as absent)', () => {
    expect(fuseFraudScores({ v1RiskScore: NaN }).fusionMode).toBe('v1');
    expect(fuseFraudScores({ v2FraudProbability: Infinity }).fusionMode).toBe('v1');
    expect(fuseFraudScores({ v1RiskScore: 'nope', v2FraudProbability: undefined }).riskScore).toBe(0);
  });
});
