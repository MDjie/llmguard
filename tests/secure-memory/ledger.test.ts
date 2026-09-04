import { describe, expect, it } from 'vitest';
import type { GuardDecision } from '@guardllm/contracts';
import { mergeRiskLedger } from '../../src/lib/secure-memory';

function decision(
  action: GuardDecision['action'],
  riskLevel: GuardDecision['riskLevel'],
  score = 0.8,
): GuardDecision {
  return {
    contractVersion: '1.0',
    decisionId: 'decision-' + action,
    traceId: 'trace-1',
    action,
    riskLevel,
    observations: action === 'ALLOW' ? [] : [{
      detectorId: 'rules',
      detectorVersion: '1',
      riskType: 'prompt_injection',
      score,
      severity: riskLevel,
      evidence: [{ viewId: 'raw', contentHmac: 'a'.repeat(64) }],
      status: 'MATCH',
    }],
    policyPath: ['policy-1'],
    bundleId: 'bundle-1',
    latencyMs: 1,
    degradationReasons: [],
  };
}

describe('secure memory risk ledger', () => {
  it('updates risk incrementally without retaining plaintext evidence', () => {
    const first = mergeRiskLedger([], decision('WARN', 'HIGH'), new Date('2026-01-01T00:00:00Z'));
    const second = mergeRiskLedger(first.entries, decision('WARN', 'HIGH'), new Date('2026-01-01T00:01:00Z'));
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({
      riskType: 'prompt_injection',
      maxScore: 0.8,
      occurrences: 2,
      evidenceHmacs: ['a'.repeat(64)],
    });
    expect(JSON.stringify(second.entries)).not.toContain('plaintext');
    expect(second.riskState).toBe('WATCH');
  });

  it('moves terminal and accumulated risk into restrictive states', () => {
    expect(mergeRiskLedger([], decision('BLOCK', 'CRITICAL', 1), new Date()).riskState)
      .toBe('LOCKED');
    expect(mergeRiskLedger([], decision('REQUIRE_REVIEW', 'HIGH'), new Date()).riskState)
      .toBe('ESCALATED');
    const previous = [{
      riskType: 'cumulative',
      maxScore: 0.9,
      occurrences: 6,
      lastAction: 'WARN',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      evidenceHmacs: [],
    }];
    expect(mergeRiskLedger(previous, decision('ALLOW', 'NONE'), new Date()).riskState)
      .toBe('ESCALATED');
  });

  it('records fail-safe degradation even without detector matches', () => {
    const degraded = {
      ...decision('BLOCK', 'HIGH'),
      observations: [],
      degradationReasons: ['required-vlm:timeout'],
    };
    const ledger = mergeRiskLedger([], degraded, new Date());
    expect(ledger.entries[0].riskType).toBe('system.degradation.required-vlm');
  });
});
