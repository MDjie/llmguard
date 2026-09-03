import { describe, expect, it } from 'vitest';
import {
  BoundedFairScheduler,
  ModelRoutingRegistry,
  buildQuotaClaims,
  estimateGuardComplexity,
  reserveAgentResources,
  selectModelRoute,
  signModelRoutingBundle,
  type AgentResourceVector,
  type ModelRoutingPayload,
} from '../../src/lib/resource-control';

const zero: AgentResourceVector = {
  toolSteps: 0, recursionDepth: 0, browserTabs: 0, processes: 0, connections: 0,
  files: 0, ocrPages: 0, mediaDurationSeconds: 0, guardInferenceTokens: 0,
};

describe('guard resource control', () => {
  it('builds minute, concurrency, daily and monthly claims for every identity scope', () => {
    const claims = buildQuotaClaims({
      tenantId: 'tenant-1', applicationId: 'app-1', userId: 'user-1',
      userGroupIds: ['group-b', 'group-a'], credentialId: 'cred-1',
      modelId: 'model-1', apiId: 'chat.complete',
    }, { inputTokens: 100, outputTokens: 50, costUnits: 7 });
    expect(new Set(claims.map((claim) => claim.scopeType))).toEqual(new Set([
      'TENANT', 'APPLICATION', 'USER', 'USER_GROUP', 'CREDENTIAL', 'MODEL', 'API',
    ]));
    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'CONCURRENCY', window: 'INSTANT', amount: 1 }),
      expect.objectContaining({ metric: 'OUTPUT_TOKENS', window: 'MINUTE', amount: 50 }),
      expect.objectContaining({ metric: 'COST_UNITS', window: 'MONTH', amount: 7 }),
    ]));
  });

  it('reserves all lifecycle dimensions atomically and refuses partial consumption', () => {
    const limits = { ...zero, toolSteps: 2, browserTabs: 1, guardInferenceTokens: 100 };
    const first = reserveAgentResources({ limits, usage: zero }, {
      ...zero, toolSteps: 1, browserTabs: 1, guardInferenceTokens: 80,
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error('expected reservation');
    const rejected = reserveAgentResources(first.budget, {
      ...zero, toolSteps: 1, browserTabs: 1, guardInferenceTokens: 30,
    });
    expect(rejected).toMatchObject({
      allowed: false,
      exhaustedResources: ['browserTabs', 'guardInferenceTokens'],
      budget: first.budget,
    });
  });

  it('prevents one tenant from monopolizing critical queue capacity and preserves a reserve', () => {
    const scheduler = new BoundedFairScheduler<string>({
      maximumQueued: 10, maximumActive: 2, reservedCriticalCapacity: 1,
      maximumCriticalQueuedPerTenant: 1,
      priorityWeights: { CRITICAL: 1, INTERACTIVE: 1, BATCH: 1 },
    });
    scheduler.enqueue({ id: 'i-1', tenantId: 'a', priority: 'INTERACTIVE', payload: 'i' });
    scheduler.enqueue({ id: 'b-1', tenantId: 'b', priority: 'BATCH', payload: 'b' });
    const first = scheduler.dequeue();
    expect(first?.priority).toBe('INTERACTIVE');
    expect(scheduler.dequeue()).toBeUndefined();
    scheduler.enqueue({ id: 'c-1', tenantId: 'a', priority: 'CRITICAL', payload: 'c' });
    expect(() => scheduler.enqueue({
      id: 'c-2', tenantId: 'a', priority: 'CRITICAL', payload: 'c2',
    })).toThrow('GUARD_SCHEDULER_CRITICAL_TENANT_CAP_EXCEEDED');
    expect(scheduler.dequeue()?.priority).toBe('CRITICAL');
    first?.complete();
  });

  it('verifies signed hot-load routing, rejects stale generations and filters unhealthy routes', () => {
    const now = 2_000_000;
    const payload: ModelRoutingPayload = {
      schemaVersion: '1.0', id: 'routing-1', generation: 1,
      issuedAtEpochMs: now, expiresAtEpochMs: now + 60_000,
      routes: [
        {
          id: 'east', endpointId: 'endpoint-east', modelId: 'business-chat', weight: 100,
          regions: ['cn-east'], dataResidencies: ['CN'], requiredPermissions: ['model:use'],
          maximumP99Ms: 200, maximumErrorRate: 0.05, minimumAcceleratorFreeRatio: 0.1,
        },
        {
          id: 'bad', endpointId: 'endpoint-bad', modelId: 'business-chat', weight: 1000,
          regions: ['cn-east'], dataResidencies: ['CN'], requiredPermissions: ['model:use'],
          maximumP99Ms: 200, maximumErrorRate: 0.05, minimumAcceleratorFreeRatio: 0.1,
        },
      ],
    };
    const bundle = signModelRoutingBundle(payload, 'routing-key-1', 'secret');
    const registry = new ModelRoutingRegistry((keyId) => keyId === 'routing-key-1' ? 'secret' : undefined, () => now);
    registry.publish(bundle, 0);
    expect(() => registry.publish(bundle, 0)).toThrow('MODEL_ROUTING_GENERATION_CONFLICT');
    const selected = selectModelRoute(registry.current(), {
      requestId: 'request-1', modelId: 'business-chat', allowedRegions: ['cn-east'],
      requiredDataResidency: 'CN', principalPermissions: ['model:use'],
    }, [
      { endpointId: 'endpoint-east', healthy: true, p95Ms: 80, p99Ms: 120, queueDepth: 1, errorRate: 0.01, acceleratorFreeRatio: 0.5 },
      { endpointId: 'endpoint-bad', healthy: false, p95Ms: 20, p99Ms: 30, queueDepth: 0, errorRate: 0, acceleratorFreeRatio: 1 },
    ]);
    expect(selected.route.id).toBe('east');
  });

  it('prices long context, modality, RAG and tool fanout before admission', () => {
    expect(estimateGuardComplexity({
      inputTokens: 70_000, requestedOutputTokens: 2_000, historicalTokens: 10_000,
      ragChunks: 30, plannedToolCalls: 10, modalities: 2,
      detectorCostUnits: 12, modelCostMultiplier: 1.5,
    })).toMatchObject({ reasonCodes: ['LONG_CONTEXT', 'HIGH_RAG_FANOUT', 'HIGH_TOOL_FANOUT', 'MULTIMODAL'] });
  });
});
