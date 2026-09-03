import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle';

export interface ModelRouteDefinition {
  readonly id: string;
  readonly endpointId: string;
  readonly modelId: string;
  readonly weight: number;
  readonly regions: readonly string[];
  readonly dataResidencies: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly maximumP99Ms: number;
  readonly maximumErrorRate: number;
  readonly minimumAcceleratorFreeRatio: number;
}

export interface ModelRoutingPayload {
  readonly schemaVersion: '1.0';
  readonly id: string;
  readonly generation: number;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly routes: readonly ModelRouteDefinition[];
}

export interface SignedModelRoutingBundle {
  readonly keyId: string;
  readonly algorithm: 'HMAC-SHA256';
  readonly payload: ModelRoutingPayload;
  readonly signature: string;
}

export interface ModelRouteHealth {
  readonly endpointId: string;
  readonly healthy: boolean;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly queueDepth: number;
  readonly errorRate: number;
  readonly acceleratorFreeRatio: number;
}

export interface ModelRouteRequest {
  readonly requestId: string;
  readonly modelId: string;
  readonly allowedRegions: readonly string[];
  readonly requiredDataResidency: string;
  readonly principalPermissions: readonly string[];
}

export interface ModelRouteSelection {
  readonly route: ModelRouteDefinition;
  readonly score: number;
  readonly bundleId: string;
  readonly bundleGeneration: number;
}

function signatureFor(payload: ModelRoutingPayload, key: string | Buffer): Buffer {
  return createHmac('sha256', key).update(canonicalJson(payload)).digest();
}

function validatePayload(payload: ModelRoutingPayload, now: number): void {
  if (!payload.id || !Number.isSafeInteger(payload.generation) || payload.generation <= 0 ||
      payload.issuedAtEpochMs > now + 60_000 || payload.expiresAtEpochMs <= now ||
      payload.expiresAtEpochMs <= payload.issuedAtEpochMs || payload.routes.length < 1 ||
      payload.routes.length > 64) throw new Error('MODEL_ROUTING_BUNDLE_INVALID');
  const ids = new Set<string>();
  for (const route of payload.routes) {
    if (!route.id || !route.endpointId || !route.modelId || ids.has(route.id) ||
        !Number.isSafeInteger(route.weight) || route.weight < 1 || route.weight > 10_000 ||
        route.maximumP99Ms <= 0 || route.maximumErrorRate < 0 || route.maximumErrorRate > 1 ||
        route.minimumAcceleratorFreeRatio < 0 || route.minimumAcceleratorFreeRatio > 1) {
      throw new Error('MODEL_ROUTING_ROUTE_INVALID');
    }
    ids.add(route.id);
  }
}

export function signModelRoutingBundle(
  payload: ModelRoutingPayload,
  keyId: string,
  key: string | Buffer,
): SignedModelRoutingBundle {
  validatePayload(payload, payload.issuedAtEpochMs);
  return { keyId, algorithm: 'HMAC-SHA256', payload, signature: signatureFor(payload, key).toString('base64url') };
}

export function verifyModelRoutingBundle(
  bundle: SignedModelRoutingBundle,
  keyResolver: (keyId: string) => string | Buffer | undefined,
  now = Date.now(),
): void {
  validatePayload(bundle.payload, now);
  const key = keyResolver(bundle.keyId);
  if (!key || bundle.algorithm !== 'HMAC-SHA256') throw new Error('MODEL_ROUTING_SIGNATURE_KEY_UNKNOWN');
  const actual = Buffer.from(bundle.signature, 'base64url');
  const expected = signatureFor(bundle.payload, key);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('MODEL_ROUTING_SIGNATURE_INVALID');
  }
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  return left.some((value) => right.includes(value));
}

function stableJitter(requestId: string, routeId: string): number {
  return createHash('sha256').update(`${requestId}\n${routeId}`).digest().readUInt32BE(0) / 0xffffffff;
}

export function selectModelRoute(
  bundle: SignedModelRoutingBundle,
  request: ModelRouteRequest,
  health: readonly ModelRouteHealth[],
): ModelRouteSelection {
  const healthByEndpoint = new Map(health.map((item) => [item.endpointId, item]));
  const candidates = bundle.payload.routes.flatMap((route) => {
    const status = healthByEndpoint.get(route.endpointId);
    const permitted = route.requiredPermissions.every((permission) =>
      request.principalPermissions.includes(permission));
    const eligible = route.modelId === request.modelId && status?.healthy === true && permitted &&
      intersects(route.regions, request.allowedRegions) &&
      route.dataResidencies.includes(request.requiredDataResidency) &&
      status.p99Ms <= route.maximumP99Ms && status.errorRate <= route.maximumErrorRate &&
      status.acceleratorFreeRatio >= route.minimumAcceleratorFreeRatio;
    if (!eligible) return [];
    const latencyScore = 1 - Math.min(1, status.p95Ms / route.maximumP99Ms);
    const errorScore = 1 - status.errorRate;
    const queueScore = 1 / (1 + status.queueDepth);
    const score = route.weight * (
      latencyScore * 0.3 + errorScore * 0.3 + queueScore * 0.2 +
      status.acceleratorFreeRatio * 0.2
    ) + stableJitter(request.requestId, route.id) * 0.000001;
    return [{ route, score }];
  }).sort((left, right) => right.score - left.score || left.route.id.localeCompare(right.route.id));
  const selected = candidates[0];
  if (!selected) throw new Error('MODEL_ROUTING_NO_HEALTHY_COMPLIANT_ROUTE');
  return {
    ...selected,
    bundleId: bundle.payload.id,
    bundleGeneration: bundle.payload.generation,
  };
}

export class ModelRoutingRegistry {
  private active?: SignedModelRoutingBundle;
  private previous?: SignedModelRoutingBundle;

  constructor(
    private readonly keyResolver: (keyId: string) => string | Buffer | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  publish(bundle: SignedModelRoutingBundle, expectedGeneration: number): void {
    verifyModelRoutingBundle(bundle, this.keyResolver, this.now());
    const currentGeneration = this.active?.payload.generation ?? 0;
    if (expectedGeneration !== currentGeneration || bundle.payload.generation !== currentGeneration + 1) {
      throw new Error('MODEL_ROUTING_GENERATION_CONFLICT');
    }
    this.previous = this.active;
    this.active = bundle;
  }

  rollback(expectedGeneration: number): void {
    if (!this.active || !this.previous || this.active.payload.generation !== expectedGeneration) {
      throw new Error('MODEL_ROUTING_ROLLBACK_UNAVAILABLE');
    }
    const current = this.active;
    this.active = this.previous;
    this.previous = current;
  }

  current(): SignedModelRoutingBundle {
    if (!this.active) throw new Error('MODEL_ROUTING_NOT_CONFIGURED');
    verifyModelRoutingBundle(this.active, this.keyResolver, this.now());
    return this.active;
  }
}
