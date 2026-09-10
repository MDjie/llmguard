import { describe, expect, it } from 'vitest';
import { summarizeDetectionDimensions } from '../../src/lib/guard-engine-v2/dimension-summary';
import { aggregateGuardDecision } from '../../src/lib/guard-engine-v2/aggregate';
import type { GuardRequest, Observation } from '../../src/lib/guard-engine-v2/types';
const observation = (riskType: string, score: number, role: Observation['decisionRole'] = 'CONFIRMED_RISK'): Observation => ({ detectorId: 'fixture', detectorVersion: '1',
  riskType, score, status: 'MATCH', severity: 'MEDIUM', evidence: [], decisionRole: role });
const request: GuardRequest = { contractVersion: '1.0', context: { requestId: 'p0-dimension-test', traceId: 'p0-dimension-trace', tenantId: 'tenant', applicationId: 'app',
  policyBundleId: 'bundle', direction: 'INPUT', absoluteDeadlineEpochMs: Date.now() + 10000 }, content: { text: 'fixture' } };
describe('P0 independent content and injection dimensions', () => {
  it('does not turn an injection finding into content risk or a content-safe assertion', () => {
    const result = summarizeDetectionDimensions([observation('prompt_injection', .99)]);
    expect(result.injection.confirmedRisk).toBe(true);
    expect(result.content).toMatchObject({ confirmedRisk: false, status: 'NOT_ASSESSED', fullyAssessed: false });
  });
  it('keeps candidates distinct and does not average model scores', () => {
    const result = summarizeDetectionDimensions([observation('CN.A4.03', .7, 'CANDIDATE'), observation('prompt_injection', .8), observation('prompt_injection', .9)]);
    expect(result.content.status).toBe('CANDIDATE');
    expect(result.injection.risks[0].confirmedScores.map(s => s.score)).toEqual([.8, .9]);
  });
  it.each([1, 2] as const)('keeps injection and content thresholds independent in policy v%s', decisionPolicyVersion => {
    const policy = { id: 'policy', bundleId: 'bundle', decisionPolicyVersion, warnThreshold: .1, blockThreshold: .2,
      failClosedOnRequiredDetectorFailure: true, riskThresholds: { prompt_injection: { warn: .4, block: .9 }, 'CN.A4.03': { warn: .3, block: .8 } } };
    const evaluate = (observations: Observation[]) => aggregateGuardDecision({ request, policy, observations, requiredDetectorFailures: [], latencyMs: 0 });
    expect(evaluate([observation('prompt_injection', .85)]).action).toBe('WARN');
    expect(evaluate([observation('CN.A4.03', .85)]).action).toBe('BLOCK');
    expect(evaluate([observation('prompt_injection', .85), observation('CN.A4.03', .35)]).action).toBe('WARN');
  });
  it('does not convert one cleared risk into complete content coverage', () => {
    const result = summarizeDetectionDimensions([{ ...observation('HARM.SELF_HARM', 0, 'CLEARED'), status: 'NO_MATCH', semanticCoverage: 'COMPLETE' }]);
    expect(result.content.fullyAssessed).toBe(false);
    expect(result.content.risks[0].status).toBe('CLEARED');
  });
});
