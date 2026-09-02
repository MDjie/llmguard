import { describe, expect, it } from 'vitest';
import {
  evaluationGateViolations,
  nextPolicyBundleState,
  resolvePolicyEvaluationGate,
} from '../../src/lib/policy-bundle';

describe('policy bundle lifecycle', () => {
  it('POL-005 enforces test, maker-checker, shadow and canary ordering', () => {
    expect(nextPolicyBundleState('draft', 'submit_test')).toBe('testing');
    expect(nextPolicyBundleState('testing', 'record_test_pass')).toBe('pending_approval');
    expect(nextPolicyBundleState('pending_approval', 'approve')).toBe('approved');
    expect(nextPolicyBundleState('approved', 'shadow')).toBe('shadow');
    expect(nextPolicyBundleState('shadow', 'canary')).toBe('canary');
    expect(nextPolicyBundleState('canary', 'activate')).toBe('active');
    expect(() => nextPolicyBundleState('draft', 'approve')).toThrow(/not allowed/);
    expect(() => nextPolicyBundleState('approved', 'activate')).toThrow(/not allowed/);
  });

  it('POL-005 requires complete evaluation evidence above all release thresholds', () => {
    const gate = resolvePolicyEvaluationGate({
      POLICY_GATE_MIN_CASES: '2000', POLICY_GATE_MIN_ACCURACY: '95',
      POLICY_GATE_MIN_RECALL: '95', POLICY_GATE_MAX_FPR: '1', POLICY_GATE_MAX_FNR: '5',
    });
    expect(evaluationGateViolations({
      status: 'completed', totalCases: 2000, completedCases: 2000,
      accuracy: '99.00', recall: '98.00', falsePositiveRate: '0.50', falseNegativeRate: '2.00',
    }, gate)).toEqual([]);
    expect(evaluationGateViolations({
      status: 'completed', totalCases: 100, completedCases: 99,
      accuracy: '94.00', recall: '90.00', falsePositiveRate: '2.00', falseNegativeRate: '10.00',
    }, gate)).toEqual([
      'EVALUATION_CASES_INSUFFICIENT', 'EVALUATION_CASES_INCOMPLETE', 'ACCURACY_BELOW_GATE',
      'RECALL_BELOW_GATE', 'FALSE_POSITIVE_RATE_ABOVE_GATE', 'FALSE_NEGATIVE_RATE_ABOVE_GATE',
    ]);
  });

  it('POL-005 supports emergency withdrawal, rollback retirement and final archive', () => {
    expect(nextPolicyBundleState('active', 'withdraw')).toBe('retired');
    expect(nextPolicyBundleState('active', 'rollback')).toBe('retired');
    expect(nextPolicyBundleState('retired', 'archive')).toBe('archived');
  });
});
