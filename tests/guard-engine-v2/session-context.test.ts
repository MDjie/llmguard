import { describe, expect, it } from 'vitest';
import type { GuardDecision } from '@guardllm/contracts';
import { chooseSessionDecision } from '../../src/lib/guard-engine-v2';

function decision(action: GuardDecision['action'], reason = 'RULE_TEST'): GuardDecision {
  return {
    contractVersion: '1.0',
    decisionId: `dec-${action}`,
    traceId: 'trace-1234567890',
    action,
    riskLevel: action === 'BLOCK' ? 'HIGH' : 'NONE',
    observations: action === 'ALLOW' ? [] : [{
      detectorId: 'rules',
      detectorVersion: '2',
      riskType: 'prompt_injection',
      score: 1,
      severity: 'HIGH',
      evidence: [{
        viewId: 'original',
        start: 0,
        end: 6,
        contentHmac: 'a'.repeat(64),
        maskedPreview: 'i***e',
      }],
      status: 'MATCH',
      reasonCode: reason,
    }],
    policyPath: ['policy-1'],
    bundleId: 'bundle-1',
    latencyMs: 3,
    degradationReasons: [],
  };
}

describe('multi-turn session decision', () => {
  it('uses a stricter combined decision without exposing historical offsets', () => {
    const result = chooseSessionDecision(decision('ALLOW'), decision('BLOCK'));
    expect(result.action).toBe('BLOCK');
    expect(result.policyPath).toContain('multi-turn-session');
    expect(result.observations[0].reasonCode).toBe('MULTI_TURN_SESSION_RISK');
    expect(result.observations[0].evidence[0]).toEqual({
      viewId: 'session_history',
      contentHmac: 'a'.repeat(64),
      maskedPreview: 'i***e',
    });
  });

  it('does not weaken or replace an equally strict current-turn decision', () => {
    const current = decision('BLOCK', 'MANDATORY_DENY');
    expect(chooseSessionDecision(current, decision('WARN'))).toBe(current);
    expect(chooseSessionDecision(current, decision('BLOCK'))).toBe(current);
  });
});
