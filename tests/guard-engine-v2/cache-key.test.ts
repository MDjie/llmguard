import { describe, expect, it } from 'vitest';
import { buildGuardCacheKey, type GuardCacheIdentity } from '../../src/lib/guard-engine-v2';

const base: GuardCacheIdentity = {
  scope: { tenantId: 'tenant-a', applicationId: 'app-a' },
  direction: 'INPUT',
  content: 'Risk content',
  policyBundleId: 'bundle-1',
  detectorVersions: { rules: '2.0.0', semantic: '1.1.0' },
  modelVersions: ['model@sha256:abc'],
  tokenizerId: 'tokenizer-v1',
  tokenizerDigest: 'sha256:' + 'a'.repeat(64),
  configurationDigest: 'sha256:' + 'b'.repeat(64),
};

describe('Guard result cache identity', () => {
  it('is stable across detector and model ordering only', () => {
    const reordered = {
      ...base,
      detectorVersions: { semantic: '1.1.0', rules: '2.0.0' },
      modelVersions: [...base.modelVersions].reverse(),
    };
    expect(buildGuardCacheKey(reordered)).toBe(buildGuardCacheKey(base));
  });

  it.each([
    ['tenant', { scope: { tenantId: 'tenant-b', applicationId: 'app-a' } }],
    ['application', { scope: { tenantId: 'tenant-a', applicationId: 'app-b' } }],
    ['direction', { direction: 'OUTPUT_COMPLETE' }],
    ['content', { content: 'risk content changed' }],
    ['bundle', { policyBundleId: 'bundle-2' }],
    ['detector', { detectorVersions: { rules: '2.0.1', semantic: '1.1.0' } }],
    ['model', { modelVersions: ['model@sha256:def'] }],
    ['tokenizer id', { tokenizerId: 'tokenizer-v2' }],
    ['tokenizer digest', { tokenizerDigest: 'sha256:' + 'c'.repeat(64) }],
    ['configuration', { configurationDigest: 'sha256:' + 'd'.repeat(64) }],
  ])('invalidates when %s changes', (_name, change) => {
    expect(buildGuardCacheKey({ ...base, ...change } as GuardCacheIdentity))
      .not.toBe(buildGuardCacheKey(base));
  });
});
