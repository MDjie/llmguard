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
  it('preserves target rule scopes on compiled exceptions', () => {
    const payload = compilePolicyBundle({
      ...config,
      rules: new Map([['dimension-1', ['rule-1', 'rule-2'].map(id => ({ ...config.rules.get('dimension-1')![0], id, config: {} }))]]),
      whitelists: [{
        id: 'allow-1',
        policyScope: 'specific',
        policyIds: ['policy-1'],
        dimensionScope: 'specific',
        dimensionCodes: ['prompt_injection'],
        targetRuleIds: ['rule-2', 'rule-1'],
        directions: ['OUTPUT_CHUNK', 'INPUT'],
        validFromEpochMs: 1_700_000_000_000,
        expiresAtEpochMs: 1_800_000_000_000,
        approvalStatus: 'approved',
        approvedBy: 'reviewer-2',
        priority: 100,
        pattern: 'approved example',
        matchType: 'contains',
        caseSensitive: false,
        enabled: true,
      }],
    }, 4, { compileTimeEpochMs: 1_750_000_000_000 });

    expect(payload.exceptions).toEqual([expect.objectContaining({
      id: 'allow-1',
      targetRuleIds: ['rule-1', 'rule-2'],
      directions: ['INPUT', 'OUTPUT_CHUNK'],
      validFromEpochMs: 1_700_000_000_000,
      expiresAtEpochMs: 1_800_000_000_000,
      approvalStatus: 'approved',
      approvedBy: 'reviewer-2',
      mandatoryDenyExempt: false,
    })]);
  });

  it.each(['rule-1', 'missing-rule'])('rejects non-exemptible or missing exception target %s', target => {
    expect(() => compilePolicyBundle({ ...config, whitelists: [{ id: 'invalid-exception', policyScope: 'specific', policyIds: ['policy-1'], dimensionScope: 'specific', dimensionCodes: ['prompt_injection'], targetRuleIds: [target], directions: ['INPUT'], validFromEpochMs: 1_700_000_000_000, expiresAtEpochMs: 1_800_000_000_000, approvalStatus: 'approved', approvedBy: 'reviewer', priority: 1, pattern: 'example', matchType: 'contains', caseSensitive: false, enabled: true }] }, 4, { compileTimeEpochMs: 1_750_000_000_000 })).toThrow('Whitelist target is missing');
  });

  it('is deterministic and rejects any payload tampering', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const payload = compilePolicyBundle(config, 4);
    expect(payload.detectorDag?.version).toBe('guard-default-dag-5');
    expect(payload.detectorDag?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ detectorId: 'content-safety-intent-baseline' }),
      expect.objectContaining({ detectorId: 'protected-context-leak' }),
    ]));
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
