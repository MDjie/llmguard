import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuardRequest, Observation } from '@guardllm/contracts';
import { judgeProfileSchema, type JudgeProfile } from '../../src/lib/judge/profile';
import { qualityBindingDigest } from '../../src/lib/judge/profile-registry';
import type { JudgeInvoker } from '../../src/lib/judge/router';
import { ConfigurableJudgeDetector } from '../../src/lib/guard-engine-v2/judge-detector';
import {
  createGuardEngine,
  withCandidateJudgeDetectorDag,
  type GuardDetector,
  type GuardEvaluationTrace,
} from '../../src/lib/guard-engine-v2';

const profile = (): JudgeProfile => judgeProfileSchema.parse({
  schemaVersion: '2.0', profileId: 'candidate-judge', revision: 1,
  tenantId: 'tenant-a', applicationId: 'app-a', displayName: 'candidate judge',
  providerId: 'offline-fixture', providerType: 'custom', baseUrl: 'https://private.example/v1',
  modelId: 'offline-fixture', deploymentMode: 'private', dataBoundaryPolicyId: 'private-only',
  authMode: 'none', directions: ['INPUT', 'OUTPUT_COMPLETE'], riskIds: ['content.candidate'],
  enabled: true, mode: 'ENFORCE', qualityEvidenceId: 'fixture-evidence',
  qualityValidUntil: '2099-01-01T00:00:00Z', promptTemplateVersion: 'guard-judge-2.0',
  adapterVersion: 'guard-chat-adapter-2.0',
});

const request = (): GuardRequest => ({
  contractVersion: '1.0',
  context: { traceId: 'p1-trace', requestId: 'p1-request', tenantId: 'tenant-a', applicationId: 'app-a',
    direction: 'INPUT', absoluteDeadlineEpochMs: Date.now() + 10_000, policyBundleId: 'p1-bundle' },
  content: { text: 'offline fixture content' },
});

function approve(value: JudgeProfile): void {
  vi.stubEnv('JUDGE_QUALITY_APPROVALS_JSON', JSON.stringify([{
    evidenceId: value.qualityEvidenceId, profileBindingDigest: qualityBindingDigest(value),
    validUntil: value.qualityValidUntil, gateStatus: 'PASS', datasetSha256: 'a'.repeat(64),
    reviewApprovalRef: 'offline-fixture',
  }]));
}

const safeJudge: JudgeInvoker = async (_profile, input) => ({
  id: input.assessmentId, latencyMs: 0, finishReason: 'stop', content: JSON.stringify({
    schemaVersion: '2.0', assessmentId: input.assessmentId, complete: true,
    assessments: [{ riskId: 'content.candidate', verdict: 'SAFE', evidence: [], reasonCode: 'FIXTURE_SAFE' }],
  }),
});

function detector(id: string, observations: readonly Observation[]): GuardDetector {
  return { id, version: 'fixture-1', required: id === 'mandatory', detect: async () => observations };
}

function subject(options: { candidate: boolean; mandatory: boolean; invoke?: JudgeInvoker }) {
  const value = profile(); approve(value);
  const mandatory = detector('mandatory', options.mandatory ? [{
    detectorId: 'mandatory', detectorVersion: 'fixture-1', riskType: 'prompt_injection', score: 1,
    severity: 'CRITICAL', evidence: [], status: 'MATCH', decisionRole: 'HARD_DENY', reasonCode: 'MANDATORY_DENY',
  }] : []);
  const candidate = detector('l3-candidate', options.candidate ? [{
    detectorId: 'l3-candidate', detectorVersion: 'fixture-1', riskType: 'content.candidate', score: .51,
    severity: 'MEDIUM', evidence: [], status: 'MATCH', decisionRole: 'CANDIDATE', reasonCode: 'L3_CANDIDATE',
  }] : []);
  const base = {
    version: 'p1-fixture', maximumCostUnits: 2,
    nodes: [
      { id: 'mandatory', detectorId: 'mandatory', tier: 'L0' as const, dependsOn: [], runCondition: 'ALWAYS' as const,
        timeoutMs: 500, maxAttempts: 1, costUnits: 1, failurePolicy: 'FAIL_CLOSED' as const },
      { id: 'l3-candidate', detectorId: 'l3-candidate', tier: 'L3' as const, dependsOn: [], runCondition: 'ALWAYS' as const,
        timeoutMs: 500, maxAttempts: 1, costUnits: 1, failurePolicy: 'DEGRADE' as const },
    ],
  };
  const dag = withCandidateJudgeDetectorDag(base, ['l3-candidate'], [value]);
  const calls = vi.fn(options.invoke ?? safeJudge);
  const traces: GuardEvaluationTrace[] = [];
  return {
    calls,
    traces,
    engine: createGuardEngine({ id: 'p1', bundleId: 'p1-bundle', warnThreshold: .5, blockThreshold: .8,
      failClosedOnRequiredDetectorFailure: false, decisionPolicyVersion: 2, judgeProfiles: [value],
      judgeCandidateFunnel: { enabled: true }, detectorDag: dag },
    [mandatory, candidate, new ConfigurableJudgeDetector([value], { invoke: calls, checkEndpoint: async () => {} })],
    { hmacKey: '0123456789abcdef0123456789abcdef', onEvaluationTrace: trace => traces.push(trace) }),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('P1 L3 candidate to L4 Judge funnel', () => {
  it('does not invoke Judge or claim missing coverage for ordinary traffic', async () => {
    const value = subject({ candidate: false, mandatory: false });
    expect((await value.engine.evaluate(request())).action).toBe('ALLOW');
    expect(value.calls).not.toHaveBeenCalled();
    expect(value.traces[0]?.nodes.find(node => node.nodeId === 'l4-configurable-judge')).toMatchObject({
      tier: 'L4', runCondition: 'WHEN_PARENT_CANDIDATES', candidateInput: false, status: 'SKIPPED',
      failurePolicy: 'DEGRADE', reason: 'RUN_CONDITION_WHEN_PARENT_CANDIDATES',
    });
  });

  it('invokes Judge only for an L3 candidate and records the candidate input', async () => {
    const value = subject({ candidate: true, mandatory: false });
    expect((await value.engine.evaluate(request())).action).toBe('ALLOW');
    expect(value.calls).toHaveBeenCalledTimes(1);
    expect(value.traces[0]?.nodes.find(node => node.nodeId === 'l4-configurable-judge')).toMatchObject({
      tier: 'L4', runCondition: 'WHEN_PARENT_CANDIDATES', candidateInput: true, status: 'NO_MATCH',
      failurePolicy: 'DEGRADE', reason: 'EXECUTED',
    });
  });

  it('never invokes Judge after a mandatory denial', async () => {
    const value = subject({ candidate: true, mandatory: true });
    expect((await value.engine.evaluate(request())).action).toBe('BLOCK');
    expect(value.calls).not.toHaveBeenCalled();
    expect(value.traces[0]?.nodes.find(node => node.nodeId === 'l4-configurable-judge')?.status).toBe('SKIPPED');
  });

  it('degrades a failed Judge to review instead of allowing a candidate', async () => {
    const value = subject({ candidate: true, mandatory: false, invoke: async () => { throw new Error('offline failure'); } });
    const result = await value.engine.evaluate(request());
    expect(result.action).toBe('REQUIRE_REVIEW');
    expect(result.degradationReasons).toContain('configurable-judge:unavailable');
    expect(value.calls).toHaveBeenCalledTimes(1);
  });
});
