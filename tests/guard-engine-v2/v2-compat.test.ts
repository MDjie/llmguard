import { describe, expect, it } from 'vitest';
import type { GuardDecision } from '@guardllm/contracts';
import type { CompiledPolicyBundle } from '../../src/lib/policy-bundle';
import { adaptGuardDecisionToDetectionResult } from '../../src/lib/detection/v2-compat';

const bundle: CompiledPolicyBundle = {
  schemaVersion: '1.0',
  policyId: 'policy-1',
  policyVersion: 7,
  dimensions: [{ id: 'dimension-1', code: 'pii.email', name: '电子邮箱', weight: 1 }],
  rules: [{
    id: 'email-rule',
    riskType: 'pii.email',
    pattern: '@',
    matchType: 'contains',
    caseSensitive: false,
    score: 0.72,
  }],
  exceptions: [],
  thresholds: [{
    dimensionId: 'dimension-1',
    warn: 0.5,
    block: 0.9,
    autoMask: true,
    autoRewrite: false,
  }],
};

function decision(action: GuardDecision['action']): GuardDecision {
  return {
    contractVersion: '1.0',
    decisionId: 'decision-1',
    traceId: 'trace-1',
    action,
    riskLevel: 'HIGH',
    observations: [{
      detectorId: 'rules',
      detectorVersion: 'policy-7',
      riskType: 'pii.email',
      score: 0.72,
      severity: 'HIGH',
      status: 'MATCH',
      reasonCode: 'RULE_email-rule',
      evidence: [{
        viewId: 'raw',
        start: 6,
        end: 23,
        maskedPreview: 'a***m@example.com',
        contentHmac: 'a'.repeat(64),
        sourceEnvelopeIds: ['env-1'],
      }],
    }],
    policyPath: ['policy-1', 'action-override'],
    bundleId: 'bundle-1',
    latencyMs: 8,
    degradationReasons: [],
    failMode: 'NORMAL',
    evidenceComplete: true,
  };
}

describe('Guard Engine V2 legacy response adapter', () => {
  it('uses the authoritative decision and masks by evidence coordinates', () => {
    const result = adaptGuardDecisionToDetectionResult(
      'email avery@example.com now',
      decision('MASK'),
      bundle,
    );
    expect(result.action).toBe('mask');
    expect(result.overallScore).toBe(72);
    expect(result.policyVersion).toBe(7);
    expect(result.maskedText).toBe('email a***************m now');
    expect(result.findings[0]).toMatchObject({
      dimension: 'pii.email',
      dimensionName: '电子邮箱',
      ruleId: 'email-rule',
      startOffset: 6,
      endOffset: 23,
      action: 'mask',
    });
    expect(result.findings[0].evidence).not.toContain('avery@example.com');
  });

  it('maps fail-safe terminal actions to the legacy block action', () => {
    expect(adaptGuardDecisionToDetectionResult('email avery@example.com now', decision('SAFE_RESPONSE'), bundle).action)
      .toBe('block');
    expect(adaptGuardDecisionToDetectionResult('email avery@example.com now', decision('REQUIRE_REVIEW'), bundle).action)
      .toBe('block');
  });
});
