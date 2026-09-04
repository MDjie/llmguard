import { describe, expect, it } from 'vitest';
import type { GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '../../src/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle';

const legacyBundle: RuntimePolicyBundle = {
  id: 'bundle-legacy-dag-3',
  generation: 3,
  payload: {
    schemaVersion: '1.0',
    policyId: 'policy-legacy-dag-3',
    policyVersion: 3,
    dimensions: [],
    rules: [],
    exceptions: [],
    thresholds: [],
    detectorDag: {
      version: 'guard-default-dag-3',
      maximumCostUnits: 10,
      nodes: [
        {
          id: 'l0-prompt-attack',
          detectorId: 'prompt-attack-baseline',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 1_500,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'l0-protected-context-leak',
          detectorId: 'protected-context-leak',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 1_500,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'l0-structured-dlp',
          detectorId: 'structured-dlp',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 1_500,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'l0-resource-abuse',
          detectorId: 'resource-abuse-baseline',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 1_500,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'l0-insurance-compliance',
          detectorId: 'insurance-compliance-baseline',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 1_500,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'l0-content-safety-intent',
          detectorId: 'content-safety-intent-baseline',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 1_500,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'l0-policy-rules',
          detectorId: 'rules',
          tier: 'L0',
          dependsOn: [],
          runCondition: 'ALWAYS',
          timeoutMs: 1_500,
          maxAttempts: 1,
          costUnits: 1,
          failurePolicy: 'FAIL_CLOSED',
        },
        {
          id: 'l3-reasoning-attribution',
          detectorId: 'reasoning-attack-baseline',
          tier: 'L3',
          dependsOn: [
            'l0-prompt-attack',
            'l0-protected-context-leak',
            'l0-structured-dlp',
            'l0-resource-abuse',
            'l0-insurance-compliance',
            'l0-content-safety-intent',
            'l0-policy-rules',
          ],
          runCondition: 'WHEN_NO_BLOCKING_MATCH',
          timeoutMs: 2_500,
          maxAttempts: 1,
          costUnits: 3,
          failurePolicy: 'FAIL_CLOSED',
        },
      ],
    },
  },
};

function request(): GuardRequest {
  return {
    contractVersion: '1.0',
    context: {
      traceId: 'trace-legacy-output-dag-0001',
      requestId: 'request-legacy-output-dag-001',
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      direction: 'INPUT',
      absoluteDeadlineEpochMs: Date.now() + 3_000,
      policyBundleId: legacyBundle.id,
    },
    content: { text: 'Please summarize the public product documentation.' },
  };
}

describe('signed policy DAG compatibility', () => {
  it('executes the exact pre-output-control DAG without requiring new detector identities', async () => {
    const engine = createEngineForPolicyBundle(
      legacyBundle,
      'legacy-output-dag-test-hmac-key-32-bytes',
    );
    const decision = await engine.evaluate(request());

    expect(decision.action).toBe('ALLOW');
    expect(decision.observations).toEqual([]);
    expect(decision.policyPath).not.toContain('output-control');
  });
});
