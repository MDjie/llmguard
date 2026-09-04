import { describe, expect, it } from 'vitest';
import {
  assertLocalDevelopmentBootstrap,
  policyPayloadContentHash,
  validateBootstrapPolicyPayload,
} from '../../src/lib/policy-bundle/bootstrap';
import type { CompiledPolicyBundle } from '../../src/lib/policy-bundle';

function validPayload(): CompiledPolicyBundle {
  const dimensions = Array.from({ length: 16 }, (_, index) => ({
    id: `dimension-${index}`,
    code: `risk_${index}`,
    name: `Risk ${index}`,
    weight: 1,
  }));
  return {
    schemaVersion: '1.0',
    policyId: 'default-policy',
    policyVersion: 1,
    dimensions,
    rules: dimensions.map((dimension, index) => ({
      id: `rule-${index}`,
      riskType: dimension.code,
      pattern: `pattern-${index}`,
      matchType: 'contains',
      caseSensitive: false,
      score: 0.8,
    })),
    exceptions: [],
    thresholds: dimensions.map((dimension) => ({
      dimensionId: dimension.id,
      warn: 0.5,
      block: 0.8,
      autoMask: false,
      autoRewrite: false,
    })),
    detectorDag: {
      version: 'test-dag-v1',
      maximumCostUnits: 10,
      nodes: [{
        id: 'rules',
        detectorId: 'rules',
        tier: 'L1',
        dependsOn: [],
        runCondition: 'ALWAYS',
        timeoutMs: 100,
        maxAttempts: 1,
        costUnits: 1,
        failurePolicy: 'FAIL_CLOSED',
      }],
    },
  };
}

describe('local default policy bootstrap guard', () => {
  it('requires an explicit acknowledgement, local profile, and loopback database', () => {
    expect(() => assertLocalDevelopmentBootstrap({
      acknowledged: true,
      deploymentProfile: 'local-compose',
      databaseUrl: 'postgres://user:password@127.0.0.1:5434/guardllm',
    })).not.toThrow();
    expect(() => assertLocalDevelopmentBootstrap({
      acknowledged: false,
      deploymentProfile: 'local-compose',
      databaseUrl: 'postgres://user:password@127.0.0.1:5434/guardllm',
    })).toThrow(/explicit/);
    expect(() => assertLocalDevelopmentBootstrap({
      acknowledged: true,
      deploymentProfile: 'production',
      databaseUrl: 'postgres://user:password@127.0.0.1:5434/guardllm',
    })).toThrow(/local-compose/);
    expect(() => assertLocalDevelopmentBootstrap({
      acknowledged: true,
      deploymentProfile: 'local-compose',
      databaseUrl: 'postgres://user:password@db.example.invalid:5432/guardllm',
    })).toThrow(/non-loopback/);
  });

  it('requires all baseline dimensions, executable rules, thresholds, and a failure-policy DAG', () => {
    expect(validateBootstrapPolicyPayload(validPayload())).toEqual({
      dimensionCount: 16,
      ruleCount: 16,
      thresholdCount: 16,
    });
    const missingDimension = validPayload();
    expect(() => validateBootstrapPolicyPayload({
      ...missingDimension,
      dimensions: missingDimension.dimensions.slice(0, 15),
      rules: missingDimension.rules.slice(0, 15),
      thresholds: missingDimension.thresholds.slice(0, 15),
    })).toThrow(/16/);
    const missingRule = validPayload();
    expect(() => validateBootstrapPolicyPayload({
      ...missingRule,
      rules: missingRule.rules.slice(1),
    })).toThrow(/rule for every dimension/);
  });

  it('changes the payload hash when the signed detector DAG changes', () => {
    const original = validPayload();
    const changed: CompiledPolicyBundle = {
      ...original,
      detectorDag: {
        ...original.detectorDag!,
        version: 'test-dag-v2',
      },
    };
    expect(policyPayloadContentHash(changed)).not.toBe(policyPayloadContentHash(original));
  });
});
