import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import type { PolicyReadinessReport } from '@/lib/policy-bundle/readiness';
import type { CompiledPolicyBundle } from '@/lib/policy-bundle/types';
import { currentDetectionCapabilities, inspectDetectionCapabilities } from '@/lib/policy-bundle/detection-capabilities';
import { DEFAULT_DETECTOR_DAG } from '@/lib/guard-engine-v2/default-dag';

const state = vi.hoisted(() => ({ inspect: vi.fn<() => Promise<PolicyReadinessReport>>() }));
vi.mock('@/lib/api-security', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api-security')>();
  const security = original.createApiSecurity({
    authenticator: async () => null,
    auditor: { record: async () => {} },
    rateLimiter: { consume: async () => ({ allowed: true, limit: 120, remaining: 119, resetAt: 60_000, retryAfterSeconds: 0 }) },
  });
  return { ...original, withApiSecurity: security.withApiSecurity };
});
vi.mock('@/lib/policy-bundle', () => ({ inspectPolicyReadiness: state.inspect, isPolicyBundleRuntimeError: () => false }));
import { GET } from '@/app/api/health/policy/route';

function readiness(declared: boolean): PolicyReadinessReport {
  const payload: CompiledPolicyBundle = {
    schemaVersion: '1.0', policyId: 'policy-1', policyVersion: 1,
    dimensions: [], rules: [], exceptions: [], thresholds: [],
    detectorDag: DEFAULT_DETECTOR_DAG,
    ...(declared ? { detectionCapabilities: currentDetectionCapabilities() } : {}),
  };
  return {
    ready: true, service: 'guardllm', bundleId: 'bundle-1', generation: 1,
    detectionCapabilities: inspectDetectionCapabilities(payload),
    publicKeyFingerprint: 'a'.repeat(64), signingKeyId: 'local-v1', signatureAlgorithm: 'Ed25519',
    deploymentProfile: 'local-compose', assurance: { level: 'operator-attested-development-only', externalApproval: false },
    profile: { id: 'policy-1', name: 'Local policy', version: 1 },
    applicationBinding: { bound: true, active: true },
    compilation: { schemaVersion: '1.0', contentHash: 'b'.repeat(64), dimensions: 1, rules: 1, thresholds: 1, detectorDagVersion: null },
    updatedAt: '2026-09-09T00:00:00.000Z',
  };
}

describe('policy health response contract', () => {
  it.each([true, false])('returns the actual capability report for declared=%s without claiming quality acceptance', async (declared) => {
    const report = readiness(declared);
    state.inspect.mockResolvedValue(report);
    const response = await GET(new NextRequest('http://localhost/api/health/policy'), {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      detectionCapabilities: { ...report.detectionCapabilities, qualityQualified: null, mediaRuntimeVerified: false },
    });
  });

  it('still rejects unexpected response fields', async () => {
    const report = { ...readiness(true), unexpected: true };
    state.inspect.mockResolvedValue(report);
    const response = await GET(new NextRequest('http://localhost/api/health/policy'), {});
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'RESPONSE_SCHEMA_FAILED' });
  });
});