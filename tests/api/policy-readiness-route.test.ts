import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inspectPolicyReadiness } = vi.hoisted(() => ({
  inspectPolicyReadiness: vi.fn(),
}));

vi.mock('@/lib/policy-bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/policy-bundle')>();
  return { ...actual, inspectPolicyReadiness };
});

import { GET } from '../../src/app/api/health/policy/route';

const ready = {
  ready: true as const,
  service: 'guardllm' as const,
  bundleId: 'bundle-1',
  generation: 3,
  publicKeyFingerprint: 'a'.repeat(64),
  signingKeyId: 'local-ed25519-v1',
  signatureAlgorithm: 'Ed25519' as const,
  deploymentProfile: 'local-compose',
  assurance: {
    level: 'operator-attested-development-only' as const,
    externalApproval: false,
  },
  profile: { id: 'policy-1', name: 'Default', version: 1 },
  applicationBinding: { bound: true as const, active: true as const },
  compilation: {
    schemaVersion: '1.0' as const,
    contentHash: 'b'.repeat(64),
    dimensions: 16,
    rules: 81,
    thresholds: 16,
    detectorDagVersion: 'guard-default-dag-1',
  },
  updatedAt: '2026-09-04T10:00:00.000Z',
};

beforeEach(() => inspectPolicyReadiness.mockReset());

describe('/api/health/policy', () => {
  it('returns a validated readiness report without secret material', async () => {
    inspectPolicyReadiness.mockResolvedValue(ready);
    const response = await GET(new NextRequest('http://localhost/api/health/policy'), {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ready: true, bundleId: 'bundle-1', generation: 3 });
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');
  });

  it('returns the precise policy failure reason while keeping details generic', async () => {
    inspectPolicyReadiness.mockImplementationOnce(() => {
      throw {
        name: 'PolicyBundleRuntimeError',
        code: 'POLICY_SIGNATURE_INVALID',
        message: 'internal signature detail',
      };
    });
    const response = await GET(new NextRequest('http://localhost/api/health/policy'), {});
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'POLICY_SIGNATURE_INVALID',
      status: 503,
      detail: 'A verified active policy bundle is not ready for this application.',
    });
  });
});
