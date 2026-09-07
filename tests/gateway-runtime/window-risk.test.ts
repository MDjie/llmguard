import { expect, it } from 'vitest';
import type { GuardDecision } from '@guardllm/contracts';
import { retainWindowRisk, windowRiskObservations } from '../../src/lib/gateway-runtime/window-risk';
it('retains warning and strongest stream risk without duplicating positional evidence or session occurrences', () => {
  const previous: GuardDecision = { contractVersion: '1.0', decisionId: 'd', traceId: 'trace', policyPath: ['p'], bundleId: 'b', latencyMs: 1, degradationReasons: [], action: 'WARN', riskLevel: 'MEDIUM', reasonCodes: ['EARLY_RISK'], observations: [{ detectorId: 'rule', detectorVersion: '1', severity: 'MEDIUM', reasonCode: 'fixture', riskType: 'fixture', status: 'MATCH', score: 0.7, evidence: [{ viewId: 'original', maskedPreview: '***', contentHmac: 'h'.repeat(64), start: 10, end: 20 }] }] };
  const current: GuardDecision = { ...previous, action: 'ALLOW', riskLevel: 'NONE', reasonCodes: [], observations: [] };
  const result = retainWindowRisk(current, previous);
  expect(result.action).toBe('WARN'); expect(result.riskLevel).toBe('MEDIUM'); expect(result.reasonCodes).toEqual(['EARLY_RISK']);
  expect(result.observations[0].evidence[0].start).toBeUndefined();
  expect(windowRiskObservations([...result.observations, ...previous.observations])).toHaveLength(1);
  expect(() => retainWindowRisk(current, { ...previous, action: 'BLOCK' })).toThrow('WINDOW_PREVIOUS_DECISION_NOT_RELEASEABLE');
});
