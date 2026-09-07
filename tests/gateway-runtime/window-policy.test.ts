import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompiledPolicyBundle } from '../../src/lib/policy-bundle/types';
import type { RuntimeManifest } from '../../packages/contracts/generated/typescript/gateway-v2';
import { captureWindowPolicy, assertWindowPolicy } from '../../src/lib/gateway-runtime/window-policy';
import { canonicalJson, sha256 } from '../../src/lib/gateway-runtime/protocol';
const bundle: CompiledPolicyBundle = { schemaVersion: '1.0', policyId: 'p', policyVersion: 1, dimensions: [], rules: [], exceptions: [], thresholds: [] };
const entry = { tenantId: 't', applicationId: 'a', bundleDigest: sha256(canonicalJson(bundle)), qualificationId: 'engineering-only', qualificationExpiresAt: 20000, contextChars: 2048, chunkChars: 1024, holdbackChars: 256, evidenceClass: 'ENGINEERING', datasetSha256: 'd'.repeat(64), reviewReference: 'isolated-test', riskIds: ['fixture'], prefixSafe: true, gateResult: 'PASS' };
afterEach(() => vi.unstubAllEnvs());
describe('operator window qualification', () => {
  it('keeps default full buffering and binds exact policy version', () => {
    vi.stubEnv('GATEWAY_STREAM_QUALIFICATIONS_JSON', ''); vi.stubEnv('GATEWAY_STREAM_QUALIFICATIONS_FILE', '');
    expect(captureWindowPolicy(entry, 'internal', bundle, 1000)).toBeUndefined();
    vi.stubEnv('GATEWAY_STREAM_QUALIFICATIONS_JSON', JSON.stringify([entry]));
    const policy = captureWindowPolicy(entry, 'internal', bundle, 1000);
    expect(policy?.configurationDigest).toHaveLength(64);
    expect(captureWindowPolicy(entry, 'internal', { ...bundle, policyVersion: 2 }, 1000)).toBeUndefined();
    expect(() => captureWindowPolicy(entry, 'confidential', bundle, 1000)).toThrow('STREAM_WINDOW_NOT_QUALIFIED');
    expect(() => captureWindowPolicy(entry, 'internal', bundle, 30000)).toThrow('STREAM_WINDOW_NOT_QUALIFIED');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => captureWindowPolicy(entry, 'internal', bundle, 1000)).toThrow('STREAM_INDEPENDENT_QUALIFICATION_REQUIRED');
  });
  it('revokes in-flight release when qualification changes or disappears', () => {
    vi.stubEnv('GATEWAY_STREAM_QUALIFICATIONS_FILE', ''); vi.stubEnv('GATEWAY_STREAM_QUALIFICATIONS_JSON', JSON.stringify([entry]));
    const windowPolicy = captureWindowPolicy(entry, 'internal', bundle, 1000)!;
    const manifest: RuntimeManifest = { tenantId: 't', applicationId: 'a', bundleId: 'b', bundleDigest: entry.bundleDigest, generation: 1, modelRoutes: ['m'], dataBoundary: 'internal', streamMode: 'WINDOW', windowQualified: true, holdbackChars: 256, windowPolicy, budgets: { maxInputChars: 10000, maxOutputChars: 10000, maxSteps: 100, maxEvents: 100, maxStreamEvents: 100, idleTimeoutMs: 1000, absoluteTimeoutMs: 5000 }, validUntil: 20000, normalizationVersion: 'guard-canonical-v2' };
    expect(assertWindowPolicy(manifest, 1000)).toEqual(windowPolicy);
    vi.stubEnv('GATEWAY_STREAM_QUALIFICATIONS_JSON', JSON.stringify([{ ...entry, contextChars: 4096 }]));
    expect(() => assertWindowPolicy(manifest, 1000)).toThrow('STREAM_QUALIFICATION_REVOKED');
    vi.stubEnv('GATEWAY_STREAM_QUALIFICATIONS_JSON', '[]');
    expect(() => assertWindowPolicy(manifest, 1000)).toThrow('STREAM_QUALIFICATION_REVOKED');
  });
});
