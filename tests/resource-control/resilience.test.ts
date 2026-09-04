import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BoundedFairScheduler,
  QuotaLimitExceededError,
  admitGuardRequest,
  estimateGuardComplexity,
  reserveAgentResources,
  type AgentResourceVector,
  type GuardQuotaLimit,
  type GuardResourceAdmissionSpec,
} from '../../src/lib/resource-control';

const scopeTypes = [
  'TENANT', 'APPLICATION', 'SESSION', 'USER', 'USER_GROUP', 'CREDENTIAL', 'MODEL', 'API',
] as const;
const metricWindows = [
  ['CONCURRENCY', 'INSTANT'], ['REQUESTS', 'MINUTE'], ['INPUT_TOKENS', 'MINUTE'],
  ['OUTPUT_TOKENS', 'MINUTE'], ['COST_UNITS', 'DAY'], ['COST_UNITS', 'MONTH'],
] as const;

function limits(): GuardQuotaLimit[] {
  return scopeTypes.flatMap((scopeType) => metricWindows.map(([metric, window]) => ({
    scopeType, metric, window, limit: 1_000_000,
  })));
}

function spec(maximumRequestCostUnits = 1_000): GuardResourceAdmissionSpec {
  return {
    modelId: 'guard-model', tokenizerId: 'exact', tokenizerDigest: `sha256:${'a'.repeat(64)}`,
    tokenizerBaseUrl: 'https://tokenizer.example.com', tokenizerPath: '/v1/count',
    tokenizerProviderType: 'custom', tokenizerTimeoutMs: 1_000,
    tokenizerMaximumRequestBytes: 2_000_000, tokenizerMaximumResponseBytes: 4_096,
    maximumInputTokens: 131_072, maximumRequestCostUnits, requestedOutputTokens: 1_000,
    sessionReserveTokens: 1_000, detectorCostUnits: 10, modelCostMultiplier: 1,
    concurrencyLeaseMs: 65_000, quotaLimits: limits(),
  };
}

const request = {
  contractVersion: '1.0' as const,
  context: {
    traceId: 'trace-resource-12345678', requestId: 'request-resource-12345678',
    tenantId: 'tenant-1', applicationId: 'app-1', sessionId: 'session-1',
    direction: 'INPUT' as const, absoluteDeadlineEpochMs: Date.now() + 60_000,
    policyBundleId: 'bundle-1', tokenizerId: 'exact',
  },
  content: {
    text: 'analyze',
    artifacts: [{
      artifactId: 'video-1', kind: 'VIDEO' as const, mediaType: 'video/mp4',
      sizeBytes: 1_024, sha256: 'b'.repeat(64),
      metadata: { durationSeconds: 7_200, frameCount: 2_000, judgeCalls: 8 },
    }],
  },
};

const principal = {
  subject: 'user-1', roles: ['SECURITY_ADMIN'] as const, permissions: ['guard:use'] as const,
  authenticationMethod: 'bearer' as const, tenantId: 'tenant-1', applicationId: 'app-1',
};

const tokenizer = async (configured: GuardResourceAdmissionSpec, text: string) => ({
  tokenizerId: configured.tokenizerId,
  tokenizerDigest: configured.tokenizerDigest,
  modelId: configured.modelId,
  exact: true as const,
  contentSha256: createHash('sha256').update(text).digest('hex'),
  totalTokens: 2,
});

const zero: AgentResourceVector = {
  toolSteps: 0, recursionDepth: 0, browserTabs: 0, processes: 0, connections: 0,
  files: 0, ocrPages: 0, mediaDurationSeconds: 0, mediaFrames: 0,
  decodingBranches: 0, judgeCalls: 0, decompressedBytes: 0, guardInferenceTokens: 0,
};

describe('resource exhaustion resilience', () => {
  it('prices decode, media, pages, Judge and decompression dimensions', () => {
    const result = estimateGuardComplexity({
      inputTokens: 1, requestedOutputTokens: 1, historicalTokens: 0, ragChunks: 0,
      plannedToolCalls: 0, modalities: 2, detectorCostUnits: 1, modelCostMultiplier: 1,
      decodingBranches: 9, decodingDepth: 4, mediaDurationSeconds: 3_601,
      mediaFrames: 1_001, documentPages: 501, judgeCalls: 5,
      decompressedBytes: 513 * 1_024 * 1_024,
    });
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'HIGH_DECODING_BRANCHES', 'DEEP_DECODING', 'LONG_MEDIA', 'HIGH_FRAME_COUNT',
      'HIGH_PAGE_COUNT', 'HIGH_JUDGE_FANOUT', 'HIGH_DECOMPRESSION_VOLUME',
    ]));
  });

  it('rejects an over-budget request before reserving quota', async () => {
    let reserved = false;
    await expect(admitGuardRequest({
      spec: spec(20), bundleId: 'bundle-1', scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
      principal, request,
      quotaStore: { async reserve() { reserved = true; return { releaseChargeIds: [] }; }, async release() {} },
      tokenizerInvoker: tokenizer,
    })).rejects.toMatchObject({ code: 'GUARD_REQUEST_BUDGET_EXCEEDED', retryable: false });
    expect(reserved).toBe(false);
  });

  it('honors caller cancellation and never invokes the tokenizer', async () => {
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    await expect(admitGuardRequest({
      spec: spec(), bundleId: 'bundle-1', scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
      principal, request, signal: controller.signal,
      quotaStore: { async reserve() { throw new Error('not reached'); }, async release() {} },
      tokenizerInvoker: async (configured, text) => {
        invoked = true;
        return tokenizer(configured, text);
      },
    })).rejects.toMatchObject({ code: 'GUARD_REQUEST_CANCELLED' });
    expect(invoked).toBe(false);
  });

  it('does not expose quota capacity in the public error message', async () => {
    await expect(admitGuardRequest({
      spec: spec(), bundleId: 'bundle-1', scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
      principal, request,
      quotaStore: {
        async reserve(input) { throw new QuotaLimitExceededError(input.claims[0], 999_999, 777_777); },
        async release() {},
      },
      tokenizerInvoker: tokenizer,
    })).rejects.toMatchObject({
      code: 'GUARD_QUOTA_EXCEEDED',
      message: 'The request exceeds an active resource policy limit',
      retryable: true,
    });
  });

  it('recovers expired leases, rejects duplicates and cancels queued work', () => {
    let now = 1_000;
    const scheduler = new BoundedFairScheduler<string>({
      maximumQueued: 4, maximumActive: 1, reservedCriticalCapacity: 0,
      maximumCriticalQueuedPerTenant: 2, leaseMs: 100, now: () => now,
    });
    scheduler.enqueue({ id: 'one', tenantId: 'a', priority: 'INTERACTIVE', payload: '1' });
    expect(() => scheduler.enqueue({ id: 'one', tenantId: 'a', priority: 'INTERACTIVE', payload: '1' }))
      .toThrow('GUARD_SCHEDULER_DUPLICATE_WORK');
    const lease = scheduler.dequeue();
    expect(lease?.expiresAtEpochMs).toBe(1_100);
    scheduler.enqueue({ id: 'two', tenantId: 'b', priority: 'BATCH', payload: '2' });
    expect(scheduler.cancel('two')).toBe(true);
    now = 1_101;
    expect(scheduler.recoverExpiredLeases()).toBe(1);
    expect(scheduler.snapshot()).toEqual({ queued: 0, active: 0 });
    lease?.complete();
  });

  it('atomically accounts for new lifecycle dimensions', () => {
    const limitsVector = { ...zero, mediaFrames: 10, judgeCalls: 2, decompressedBytes: 1_000 };
    const result = reserveAgentResources({ limits: limitsVector, usage: zero }, {
      ...zero, mediaFrames: 11, judgeCalls: 1, decompressedBytes: 1_001,
    });
    expect(result).toMatchObject({
      allowed: false,
      exhaustedResources: ['mediaFrames', 'decompressedBytes'],
      budget: { usage: zero },
    });
  });
});
