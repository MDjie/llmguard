import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/storage/database/shared/db', async () => {
  const { applicationPolicyBindings } = await import('@/storage/database/shared/schema');
  const binding = {
    tenantId: 'tenant-1',
    applicationId: 'app-1',
    activeBundleId: 'bundle-active',
    shadowBundleId: null,
    canaryBundleId: null,
    previousBundleId: 'bundle-prev',
    generation: 3,
    canaryPercent: 0,
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
  };
  const bundleRows = [
    { id: 'bundle-active', version: 2, state: 'active', contentHash: 'a'.repeat(64), signingKeyId: 'key-1', policyId: 'policy-1' },
    { id: 'bundle-prev', version: 1, state: 'retired', contentHash: 'b'.repeat(64), signingKeyId: 'key-1', policyId: 'policy-1' },
  ];
  // Dispatch by table so repeated calls across tests stay stateless.
  const select = () => {
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        const promise = Promise.resolve(table === applicationPolicyBindings ? [binding] : bundleRows);
        chain.then = (onFulfilled: never, onRejected: never) => promise.then(onFulfilled, onRejected);
        chain.limit = () => promise;
        return chain;
      },
      where: () => chain,
    };
    return chain;
  };
  return { db: { select } };
});

vi.mock('@/lib/policy-bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/policy-bundle')>();
  return {
    ...actual,
    loadVerifiedPolicyBundle: vi.fn(),
    inspectPolicyReadiness: vi.fn(),
  };
});

import { getPolicyRuntimeSummary } from '../../src/lib/policy-governance/runtime';
import { inspectPolicyReadiness, loadVerifiedPolicyBundle, PolicyBundleRuntimeError } from '../../src/lib/policy-bundle';

beforeEach(() => {
  vi.mocked(loadVerifiedPolicyBundle).mockReset();
  vi.mocked(inspectPolicyReadiness).mockReset();
});

describe('policy runtime summary degradation', () => {
  it('reports NOT READY with the reason code when the active bundle cannot be verified', async () => {
    const unavailable = new PolicyBundleRuntimeError(
      'POLICY_SIGNING_KEY_UNTRUSTED',
      'Policy verification key identity is unavailable',
    );
    vi.mocked(loadVerifiedPolicyBundle).mockRejectedValue(unavailable);
    vi.mocked(inspectPolicyReadiness).mockRejectedValue(unavailable);

    const summary = await getPolicyRuntimeSummary({ tenantId: 'tenant-1', applicationId: 'app-1' });

    expect(summary.ready).toBe(false);
    expect(summary.signatureVerified).toBe(false);
    expect(summary.reasonCode).toBe('POLICY_SIGNING_KEY_UNTRUSTED');
    expect(summary.generation).toBe(3);
    expect(summary.binding?.active).toMatchObject({ id: 'bundle-active', state: 'active' });
    expect(summary.binding?.previous).toMatchObject({ id: 'bundle-prev', state: 'retired' });
    expect(summary.governedDigests).toEqual({ dictionaryDigests: [], modelDigests: [], tokenizerDigest: null });
  });

  it('keeps verified digests and a verified signature when the bundle loads', async () => {
    vi.mocked(loadVerifiedPolicyBundle).mockResolvedValue({
      payload: {
        dictionaryReleases: [{ dictionaryId: 'lex', version: '1', contentHash: 'cafe' }],
        modelDigests: [],
        tokenizer: { id: 'tok', version: '1', sha256: 'feed' },
      },
    } as unknown as Awaited<ReturnType<typeof loadVerifiedPolicyBundle>>);
    vi.mocked(inspectPolicyReadiness).mockResolvedValue({ ready: true, assurance: 'production-approved' } as unknown as Awaited<ReturnType<typeof inspectPolicyReadiness>>);

    const summary = await getPolicyRuntimeSummary({ tenantId: 'tenant-1', applicationId: 'app-1' });

    expect(summary.ready).toBe(true);
    expect(summary.signatureVerified).toBe(true);
    expect(summary.reasonCode).toBeNull();
    expect(summary.governedDigests.dictionaryDigests).toEqual([{ id: 'lex', version: '1', sha256: 'cafe' }]);
    expect(summary.governedDigests.tokenizerDigest).toEqual({ id: 'tok', version: '1', sha256: 'feed' });
  });
});
