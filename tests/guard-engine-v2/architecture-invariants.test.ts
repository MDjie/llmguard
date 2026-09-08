import { describe, expect, it } from 'vitest';
import { ruleMatchConstraintsSchema } from '../../src/lib/guard-engine-v2/rule-constraints';
import type { GuardAction, GuardDecision } from '@guardllm/contracts';
import { chooseSessionDecision } from '../../src/lib/guard-engine-v2/session-context';
import { applySessionRiskControl } from '../../src/lib/secure-memory/session-risk-state';
import { normalizeWithBudget } from '../../src/lib/guard-engine-v2/normalization';
import { createObservationPolicy } from '../../src/lib/guard-engine-v2/observation-policy';
import { combineActionConstraints } from '../../src/lib/guard-engine-v2/action-constraints';

function decision(action: GuardAction, id: string): GuardDecision {
  return { contractVersion: '1.0', decisionId: id, traceId: 'trace-architecture',
    bundleId: 'bundle-a', action, riskLevel: 'HIGH', policyPath: [], latencyMs: 1,
    degradationReasons: [], observations: [{ detectorId: id, detectorVersion: '1',
      riskType: 'prompt_injection', score: 0.9, severity: 'HIGH', status: 'MATCH',
      evidence: [{ viewId: 'original', start: 0, end: 4, contentHmac: id.repeat(64).slice(0,64) }] }] };
}
describe('detection architecture safety invariants', () => {
  it('preserves review through session selection and session escalation', () => {
    const current = decision('REQUIRE_REVIEW', 'a');
    expect(chooseSessionDecision(current, decision('SAFE_RESPONSE', 'b')).action).toBe('REQUIRE_REVIEW');
    expect(applySessionRiskControl(current, { state: 'ESCALATED', enhancedDetection: true,
      concurrencyPercent: 50, minimumAction: 'SAFE_RESPONSE', reasonCodes: ['TEST'] }).action).toBe('REQUIRE_REVIEW');
  });
  it('retains both current and historical evidence without releasing historical transformed text', () => {
    const current = decision('BLOCK', 'a');
    const historical = { ...decision('WARN', 'b'), transformedText: 'historical content' };
    const result = chooseSessionDecision(current, historical);
    expect(result.observations.map(o => o.detectorId)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(result.observations.find(o => o.detectorId === 'a')?.evidence[0].start).toBe(0);
    expect(result.observations.find(o => o.detectorId === 'b')?.evidence[0].start).toBeUndefined();
    expect(result.transformedText).toBeUndefined();
  });
  const actions: readonly GuardAction[] = ['ALLOW','WARN','MASK','REWRITE','SAFE_RESPONSE','REQUIRE_REVIEW','BLOCK'];
  it.each(actions.flatMap(a => actions.map(b => [a,b] as const)))('unions %s and %s without weakening constraints', (a,b) => {
    expect(chooseSessionDecision(decision(a,'a'),decision(b,'b')).action).toBe(combineActionConstraints([a,b]).action);
  });
});

describe('normalization and terminal decisions', () => {
  it('reports actual truncation while a plain original needs no extra view', () => {
    const truncated = normalizeWithBudget('base64: aGVsbG8gd29ybGQ=', { maxViews: 1 });
    expect(truncated.coverageState).toBe('PARTIAL');
    expect(truncated.reasonCodes).toContain('NORMALIZATION_VIEW_LIMIT');
    expect(normalizeWithBudget('ordinary text', { maxViews: 1 }).coverageState).toBe('COMPLETE');
  });
  it('does not treat a candidate or a transformable output match as a terminal block', () => {
    const resolver = createObservationPolicy({ id: 'p', bundleId: 'b', warnThreshold: .5, blockThreshold: .8,
      failClosedOnRequiredDetectorFailure: true, actionOverrides: { prompt_injection: 'MASK' } }, 'OUTPUT_COMPLETE');
    const match = decision('MASK','a').observations[0];
    expect(resolver.terminal({ ...match, decisionRole: 'CANDIDATE' })).toBe(false);
    expect(resolver.terminal(match)).toBe(false);
    expect(resolver.terminal({ ...match, reasonCode: 'MANDATORY_DENY' })).toBe(true);
  });
});

it('rejects a misspelled normalization mode instead of silently disabling a rule',()=>{
  expect(ruleMatchConstraintsSchema.safeParse({normalizationModes:['base_64']}).success).toBe(false);
  expect(ruleMatchConstraintsSchema.safeParse({normalizationModes:['original','base64']}).success).toBe(true);
});
