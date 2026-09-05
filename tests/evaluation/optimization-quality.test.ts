import { describe, expect, it } from 'vitest';
import { calculateSafetyMetrics, rate, checkQualityGates } from '../../src/lib/evaluation/quality-gates';
import { validateDataset, detectionCaseSchema } from '../../src/lib/evaluation/optimization-dataset';

describe('versioned optimization evidence', () => {
  it('does not treat WARN-and-continue as a successful block', () => {
    const result = calculateSafetyMetrics([{ groupId: 'g1', expectedRiskIds: ['risk'], confirmedRiskIds: ['risk'], actualAction: 'WARN', acceptableActions: ['BLOCK'], effectSafe: false, complete: true }], ['risk']);
    expect(result.risk.recall.value).toBe(1);
    expect(result.actionCorrectness.value).toBe(0);
  });
  it('returns insufficient evidence for zero denominators and missing reports', () => {
    expect(rate(0, 0).value).toBeNull();
    expect(checkQualityGates({}, [{ metric: 'recall', operator: '>=', value: 0.9 }]).status).toBe('INSUFFICIENT_EVIDENCE');
  });
  it('does not count unknown as detection or review as automatic coverage', () => {
    const result = calculateSafetyMetrics([{ groupId: 'g1', expectedRiskIds: ['risk'], confirmedRiskIds: [], actualAction: 'REQUIRE_REVIEW', acceptableActions: ['BLOCK'], effectSafe: true, complete: false }], ['risk']);
    expect(result.risk.fnr.value).toBe(1);
    expect(result.automaticCoverage.value).toBe(0);
  });
  it('retains the Wilson upper bound with zero observed misses', () => {
    expect(rate(0, 600).upper95).toBeGreaterThan(0.006);
    expect(checkQualityGates({ fnr: rate(0, 10) }, [{ metric: 'fnr', operator: '<=', value: 0.01, bound: 'wilson_upper' }]).status).toBe('FAIL');
  });
  it('rejects duplicate independent groups', () => {
    const item = { groupId: 'g', expectedRiskIds: [], confirmedRiskIds: [], actualAction: 'ALLOW' as const, acceptableActions: ['ALLOW' as const], effectSafe: true, complete: true };
    expect(() => calculateSafetyMetrics([item, item], [])).toThrow('DUPLICATE_GROUP');
  });
  it('rejects split leakage and does not promote synthetic candidates to gold', () => {
    const a = detectionCaseSchema.parse({ caseId: 'a', groupId: 'g', sourceId: 's', sourceLicense: 'internal', sourceHash: 'a'.repeat(64), split: 'development', text: 'a normal example', expectedRiskIds: [], acceptableActions: ['ALLOW'], annotationStatus: 'needs_review' });
    const b = { ...a, caseId: 'b', split: 'test' as const };
    const result = validateDataset([a, b]);
    expect(result.errors).toContain('GROUP_SPLIT_LEAKAGE:g');
    expect(result.goldCount).toBe(0);
  });
});
