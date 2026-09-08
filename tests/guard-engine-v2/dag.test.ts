import { describe, expect, it } from 'vitest';
import type { GuardRequest } from '@guardllm/contracts';
import {
  createGuardEngine,
  type DetectorDagSpec,
  type GuardDetector,
  type Observation,
} from '../../src/lib/guard-engine-v2';
import {
  renderPrometheusMetrics,
  resetMetricsForTests,
} from '../../src/lib/observability/metrics';

const hmacKey = 'detector-dag-test-hmac-key-32-bytes-minimum';

function request(text = 'candidate'): GuardRequest {
  return {
    contractVersion: '1.0',
    context: {
      traceId: 'trace-dag-000000000001',
      requestId: 'request-dag-0001',
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      direction: 'INPUT',
      absoluteDeadlineEpochMs: Date.now() + 2_000,
      policyBundleId: 'bundle-1',
    },
    content: { text },
  };
}

function observation(detectorId: string, score: number): Observation {
  return {
    detectorId,
    detectorVersion: '1',
    riskType: 'dag.test',
    score,
    severity: score >= 0.8 ? 'HIGH' : 'MEDIUM',
    evidence: [{
      viewId: 'original',
      start: 0,
      end: 1,
      contentHmac: 'a'.repeat(64),
    }],
    status: 'MATCH',
    reasonCode: 'DAG_TEST',
  };
}

function detector(
  id: string,
  required: boolean,
  detect: GuardDetector['detect'],
): GuardDetector {
  return { id, version: '1', required, detect };
}

function engine(detectors: readonly GuardDetector[], detectorDag: DetectorDagSpec) {
  return createGuardEngine(
    {
      id: 'policy-1',
      bundleId: 'bundle-1',
      warnThreshold: 0.5,
      blockThreshold: 0.8,
      failClosedOnRequiredDetectorFailure: true,
      detectorDag,
    },
    detectors,
    { hmacKey },
  );
}

describe('UWP-02 signed detector DAG execution', () => {
  it('honors dependencies and conditionally escalates without emitting expected skips', async () => {
    const calls: string[] = [];
    const detectors = [
      detector('base', true, async () => {
        calls.push('base');
        return [observation('base', 0.4)];
      }),
      detector('deep', false, async () => {
        calls.push('deep');
        return [observation('deep', 0.6)];
      }),
      detector('failure-only', false, async () => {
        calls.push('failure-only');
        return [];
      }),
    ];
    const result = await engine(detectors, {
      version: 'test-1',
      maximumCostUnits: 3,
      nodes: [
        {
          id: 'base',
          detectorId: 'base',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 100,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'deep',
          detectorId: 'deep',
          tier: 'L2',
          dependsOn: ['base'],
          runCondition: 'WHEN_PARENT_MATCHES',
          timeoutMs: 100,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'DEGRADE',
        },
        {
          id: 'failure-only',
          detectorId: 'failure-only',
          tier: 'L3',
          dependsOn: ['base'],
          runCondition: 'WHEN_PARENT_FAILS',
          timeoutMs: 100,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'DEGRADE',
        },
      ],
    }).evaluate(request());
    expect(calls).toEqual(['base', 'deep']);
    expect(result.action).toBe('WARN');
    expect(result.observations.map((item) => item.detectorId)).toEqual(['base', 'deep']);
  });

  it('skips deep inspection after a blocking parent result', async () => {
    let deepCalls = 0;
    const detectors = [
      detector('base', true, async () => [observation('base', 1)]),
      detector('deep', false, async () => {
        deepCalls += 1;
        return [];
      }),
    ];
    const result = await engine(detectors, {
      version: 'test-1',
      maximumCostUnits: 2,
      nodes: [
        {
          id: 'base',
          detectorId: 'base',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 100,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'deep',
          detectorId: 'deep',
          tier: 'L3',
          dependsOn: ['base'],
          runCondition: 'WHEN_NO_BLOCKING_MATCH',
          timeoutMs: 100,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'DEGRADE',
        },
      ],
    }).evaluate(request());
    expect(result.action).toBe('BLOCK');
    expect(deepCalls).toBe(0);
  });

  it('retries within the signed attempt and cost bounds', async () => {
    let attempts = 0;
    const flaky = detector('flaky', true, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return [];
    });
    const result = await engine([flaky], {
      version: 'test-1',
      maximumCostUnits: 2,
      nodes: [{
        id: 'flaky',
        detectorId: 'flaky',
        tier: 'L1',
        dependsOn: [],
        runCondition: 'ALWAYS',
        timeoutMs: 100,
        maxAttempts: 2,
        costUnits: 1,
        failurePolicy: 'FAIL_CLOSED',
      }],
    }).evaluate(request());
    expect(attempts).toBe(2);
    expect(result.action).toBe('ALLOW');
    expect(result.failMode).toBe('NORMAL');
  });

  it('fails closed on node timeout and signed cost-budget exhaustion', async () => {
    resetMetricsForTests();
    const hanging = detector(
      'a-hanging',
      true,
      async () => new Promise<readonly Observation[]>(() => undefined),
    );
    const budgeted = detector('b-budgeted', true, async () => []);
    const result = await engine([hanging, budgeted], {
      version: 'test-1',
      maximumCostUnits: 1,
      nodes: [
        {
          id: 'a',
          detectorId: 'a-hanging',
          tier: 'L2',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 20,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'b',
          detectorId: 'b-budgeted',
          tier: 'L2',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 20,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
      ],
    }).evaluate(request());
    expect(result.action).toBe('BLOCK');
    expect(result.failMode).toBe('FAIL_CLOSED');
    expect(result.degradationReasons).toEqual([
      'a-hanging:unavailable',
      'b-budgeted:cost-budget-exceeded',
    ]);
    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain('guardllm_detector_runs_total');
    expect(metrics).toContain('guardllm_detector_input_chars');
    expect(metrics).toContain('status="TIMEOUT"');
    expect(metrics).toContain('status="SKIPPED"');
  });

  it('rejects cycles, unknown dependencies and registry drift at construction', () => {
    const single = detector('single', true, async () => []);
    const baseNode = {
      detectorId: 'single',
      tier: 'L0' as const,
      runCondition: 'ALWAYS' as const,
      timeoutMs: 100,
      maxAttempts: 1,
      costUnits: 1,
      failurePolicy: 'FAIL_CLOSED' as const,
    };
    expect(() => engine([single], {
      version: 'cycle',
      maximumCostUnits: 1,
      nodes: [{ ...baseNode, id: 'single', dependsOn: ['single'] }],
    })).toThrow('GRD_DETECTOR_DAG_INVALID');
    expect(() => engine([single], {
      version: 'unknown',
      maximumCostUnits: 1,
      nodes: [{ ...baseNode, id: 'single', dependsOn: ['missing'] }],
    })).toThrow('GRD_DETECTOR_DAG_DEPENDENCY_UNKNOWN');
    expect(() => engine([single], {
      version: 'drift',
      maximumCostUnits: 1,
      nodes: [],
    })).toThrow('GRD_DETECTOR_DAG_INVALID');
  });
});

describe('terminal scheduling shares final action semantics', () => {
  it.each(['candidate', 'mask'] as const)('runs required downstream checks after a high-score %s', async mode => {
    let downstream = 0;
    const detectors: readonly GuardDetector[] = [
      detector('base', true, async () => [{ ...observation('base', .94),
        ...(mode === 'candidate' ? { decisionRole: 'CANDIDATE' as const } : {}) }]),
      detector('deep', true, async () => { downstream++; return []; }),
    ];
    const dag: DetectorDagSpec = { version: 'terminal-regression', maximumCostUnits: 2,
      nodes: detectors.map((d,index) => ({ id: d.id, detectorId: d.id, tier: 'L0',
        dependsOn: index ? ['base'] : [], runCondition: index ? 'WHEN_NO_BLOCKING_MATCH' : 'ALWAYS',
        timeoutMs: 1000, maxAttempts: 1, costUnits: 1, failurePolicy: 'FAIL_CLOSED' })) };
    const subject = createGuardEngine({ id: 'p', bundleId: 'bundle-1', warnThreshold: .5,
      blockThreshold: .8, failClosedOnRequiredDetectorFailure: true, detectorDag: dag,
      ...(mode === 'mask' ? { actionOverrides: { 'dag.test': 'MASK' as const } } : {}) }, detectors, { hmacKey });
    const req = request();
    await subject.evaluate({ ...req, context: { ...req.context, direction: 'OUTPUT_COMPLETE' } });
    expect(downstream).toBe(1);
  });
});
