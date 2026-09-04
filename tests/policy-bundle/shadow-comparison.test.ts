import { describe, expect, it } from 'vitest';
import type { GuardDecision } from '@guardllm/contracts';
import { compareShadowDecisions } from '../../src/lib/policy-governance';

function decision(action: GuardDecision['action'], risks: readonly string[]): GuardDecision {
  return {
    contractVersion: '1.0', decisionId: 'decision-' + action, traceId: 'trace-1', action,
    riskLevel: risks.length ? 'HIGH' : 'NONE',
    observations: risks.map((riskType, index) => ({
      detectorId: 'detector-' + index, detectorVersion: '1.0.0', riskType,
      score: 0.9, severity: 'HIGH', status: 'MATCH', reasonCode: 'TEST_MATCH', evidence: [],
    })),
    policyPath: ['policy-1'], bundleId: 'bundle-1', latencyMs: 10, degradationReasons: [],
  };
}

describe('active versus shadow comparison', () => {
  it('reports action, newly detected and missed risk differences without content', () => {
    const result = compareShadowDecisions({
      active: decision('WARN', ['prompt_injection']),
      shadow: decision('BLOCK', ['prompt_injection', 'reasoning_attack']),
      activeLatencyMs: 8,
      shadowLatencyMs: 12,
    });
    expect(result).toEqual({
      activeAction: 'WARN', shadowAction: 'BLOCK', actionChanged: true,
      activeHitCount: 1, shadowHitCount: 2,
      newRiskCategories: ['reasoning_attack'], missedRiskCategories: [],
      activeLatencyMs: 8, shadowLatencyMs: 12, latencyDeltaMs: 4,
    });
  });
});
