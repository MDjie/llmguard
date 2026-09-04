import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  admitGuardRequest,
  guardResourceAdmissionSpecSchema,
  QuotaRequestReplayError,
  type GuardQuotaLimit,
  type GuardQuotaStore,
  type GuardResourceAdmissionSpec,
} from '../../src/lib/resource-control';

const scopeTypes = [
  'TENANT', 'APPLICATION', 'SESSION', 'USER', 'USER_GROUP', 'CREDENTIAL', 'MODEL', 'API',
] as const;
const metricWindows = [
  ['CONCURRENCY', 'INSTANT'],
  ['REQUESTS', 'MINUTE'],
  ['INPUT_TOKENS', 'MINUTE'],
  ['OUTPUT_TOKENS', 'MINUTE'],
  ['COST_UNITS', 'DAY'],
  ['COST_UNITS', 'MONTH'],
] as const;

function quotaLimits(): GuardQuotaLimit[] {
  return scopeTypes.flatMap((scopeType) => metricWindows.map(([metric, window]) => ({
    scopeType,
    metric,
    window,
    limit: 1_000_000,
  })));
}

function spec(): GuardResourceAdmissionSpec {
  return {
    modelId: 'guard-model',
    tokenizerId: 'exact-tokenizer',
    tokenizerDigest: 'sha256:' + 'a'.repeat(64),
    tokenizerBaseUrl: 'https://tokenizer.example.com',
    tokenizerPath: '/v1/count',
    tokenizerProviderType: 'custom',
    tokenizerTimeoutMs: 1_000,
    tokenizerMaximumRequestBytes: 2_000_000,
    tokenizerMaximumResponseBytes: 4_096,
    maximumInputTokens: 131_072,
    maximumRequestCostUnits: 100_000,
    requestedOutputTokens: 2_048,
    sessionReserveTokens: 4_096,
    detectorCostUnits: 10,
    modelCostMultiplier: 1,
    concurrencyLeaseMs: 65_000,
    quotaLimits: quotaLimits(),
  };
}

const request = {
  contractVersion: '1.0' as const,
  context: {
    traceId: 'trace-1234567890',
    requestId: 'request-12345678',
    tenantId: 'tenant-1',
    applicationId: 'app-1',
    sessionId: 'session-1',
    direction: 'INPUT' as const,
    absoluteDeadlineEpochMs: Date.now() + 60_000,
    policyBundleId: 'bundle-1',
    tokenizerId: 'exact-tokenizer',
  },
  content: { text: 'hello world' },
};

describe('Guard resource admission', () => {
  it('requires complete quota coverage in the signed configuration', () => {
    expect(guardResourceAdmissionSpecSchema().parse(spec()).quotaLimits).toHaveLength(48);
    expect(() => guardResourceAdmissionSpecSchema().parse({
      ...spec(),
      quotaLimits: spec().quotaLimits.slice(1),
    })).toThrow('Quota coverage is incomplete');
  });

  it('binds exact tokenization to tokenizer, model and content before reserving quota', async () => {
    let reserved = 0;
    let released = 0;
    const store: GuardQuotaStore = {
      async reserve(input) {
        reserved = input.claims.length;
        return { releaseChargeIds: ['lease-1'] };
      },
      async release(_scope, ids) {
        released += ids.length;
      },
    };
    const admission = await admitGuardRequest({
      spec: spec(),
      bundleId: 'bundle-1',
      scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
      principal: {
        subject: 'user-1',
        roles: ['SECURITY_ADMIN'],
        permissions: ['guard:use'],
        authenticationMethod: 'bearer',
        tenantId: 'tenant-1',
        applicationId: 'app-1',
      },
      request,
      quotaStore: store,
      tokenizerInvoker: async (configured, text) => ({
        tokenizerId: configured.tokenizerId,
        tokenizerDigest: configured.tokenizerDigest,
        modelId: configured.modelId,
        exact: true,
        contentSha256: createHash('sha256').update(text).digest('hex'),
        totalTokens: 2,
      }),
    });
    expect(admission.inputTokens).toBe(2);
    expect(reserved).toBe(36);
    await admission.release();
    await admission.release();
    expect(released).toBe(1);
  });

  it('fails closed when tokenizer evidence is bound to different content', async () => {
    await expect(admitGuardRequest({
      spec: spec(),
      bundleId: 'bundle-1',
      scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
      principal: {
        subject: 'user-1',
        roles: ['SECURITY_ADMIN'],
        permissions: ['guard:use'],
        authenticationMethod: 'bearer',
        tenantId: 'tenant-1',
        applicationId: 'app-1',
      },
      request,
      quotaStore: {
        async reserve() { throw new Error('must not reserve'); },
        async release() {},
      },
      tokenizerInvoker: async (configured) => ({
        tokenizerId: configured.tokenizerId,
        tokenizerDigest: configured.tokenizerDigest,
        modelId: configured.modelId,
        exact: true,
        contentSha256: '0'.repeat(64),
        totalTokens: 2,
      }),
    })).rejects.toThrow('Tokenizer identity or content binding');
  });

  it('rejects request ID replay instead of reusing a released concurrency charge', async () => {
    await expect(admitGuardRequest({
      spec: spec(),
      bundleId: 'bundle-1',
      scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
      principal: {
        subject: 'user-1',
        roles: ['SECURITY_ADMIN'],
        permissions: ['guard:use'],
        authenticationMethod: 'bearer',
        tenantId: 'tenant-1',
        applicationId: 'app-1',
      },
      request,
      quotaStore: {
        async reserve() { throw new QuotaRequestReplayError(); },
        async release() {},
      },
      tokenizerInvoker: async (configured, text) => ({
        tokenizerId: configured.tokenizerId,
        tokenizerDigest: configured.tokenizerDigest,
        modelId: configured.modelId,
        exact: true,
        contentSha256: createHash('sha256').update(text).digest('hex'),
        totalTokens: 2,
      }),
    })).rejects.toMatchObject({ code: 'GUARD_REQUEST_ID_REPLAYED' });
  });
});
