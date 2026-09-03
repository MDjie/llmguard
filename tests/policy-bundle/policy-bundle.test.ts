import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compilePolicyBundle,
  selectBoundBundleId,
  signPolicyBundle,
  verifyPolicyBundle,
} from '../../src/lib/policy-bundle';
import type { CachedPolicyConfig } from '../../src/lib/detection/types';

const config: CachedPolicyConfig = {
  policyId: 'policy-1',
  version: 3,
  cachedAt: 0,
  dimensions: [{
    id: 'dimension-1',
    code: 'prompt_injection',
    name: 'Prompt injection',
    weight: 1,
    priority: 1,
    enabled: true,
    isSystem: true,
    config: {},
  }],
  rules: new Map([['dimension-1', [{
    id: 'rule-1',
    dimensionId: 'dimension-1',
    name: 'Ignore',
    type: 'keyword',
    pattern: 'ignore',
    matchType: 'contains',
    caseSensitive: false,
    score: 100,
    confidence: 1,
    priority: 1,
    enabled: true,
    config: { mandatoryDeny: true },
  }]]]),
  ruleGroups: new Map(),
  whitelists: [],
  dimensionConfigs: [{
    id: 'config-1',
    policyId: 'policy-1',
    dimensionId: 'dimension-1',
    enabled: true,
    warnEnabled: true,
    blockEnabled: true,
    warnThreshold: 50,
    blockThreshold: 80,
    autoMask: false,
    autoRewrite: false,
    actionConfig: {},
  }],
};

describe('signed policy bundles', () => {
  it('is deterministic and rejects any payload tampering', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const payload = compilePolicyBundle(config, 4);
    expect(payload.detectorDag?.version).toBe('guard-default-dag-1');
    expect(payload.detectorDag?.nodes.map((node) => node.tier))
      .toEqual(expect.arrayContaining(['L0', 'L3']));
    const signed = signPolicyBundle(payload, { privateKey, signingKeyId: 'test-key' });
    expect(verifyPolicyBundle(signed, publicKey)).toBe(true);
    expect(signPolicyBundle(payload, { privateKey, signingKeyId: 'test-key' }).contentHash)
      .toBe(signed.contentHash);
    expect(verifyPolicyBundle({
      ...signed,
      payload: { ...payload, policyVersion: 5 },
    }, publicKey)).toBe(false);
    expect(verifyPolicyBundle({
      ...signed,
      payload: {
        ...payload,
        detectorDag: {
          ...payload.detectorDag!,
          maximumCostUnits: 9_999,
        },
      },
    }, publicKey)).toBe(false);
  });

  it('selects canary bundles with a stable server-side routing hash', () => {
    const binding = {
      activeBundleId: 'active-1',
      canaryBundleId: 'canary-2',
      canaryPercent: 20,
    };
    const selections = Array.from({ length: 100 }, (_, index) =>
      selectBoundBundleId(binding, `request-${index}`),
    );
    expect(selections.every((id) => id === 'active-1' || id === 'canary-2')).toBe(true);
    expect(selections.filter((id) => id === 'canary-2').length).toBeGreaterThan(5);
    expect(selections.filter((id) => id === 'canary-2').length).toBeLessThan(40);
    expect(selectBoundBundleId(binding, 'request-42'))
      .toBe(selectBoundBundleId(binding, 'request-42'));
  });
});
