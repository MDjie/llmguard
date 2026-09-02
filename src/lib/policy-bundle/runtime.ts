import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import {
  applicationPolicyBindings,
  policyBundles,
} from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { verificationPublicKey, verifyPolicyBundle } from './crypto';
import type { CompiledPolicyBundle } from './types';

const ruleSchema = z.object({
  id: z.string(),
  riskType: z.string(),
  pattern: z.string(),
  matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']),
  caseSensitive: z.boolean(),
  score: z.number().min(0).max(1),
  mandatoryDeny: z.boolean().optional(),
}).strict();
const payloadSchema = z.object({
  schemaVersion: z.literal('1.0'),
  policyId: z.string(),
  policyVersion: z.number().int().positive(),
  dimensions: z.array(z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    weight: z.number(),
  }).strict()),
  rules: z.array(ruleSchema),
  exceptions: z.array(z.object({
    id: z.string(),
    pattern: z.string(),
    matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']),
    caseSensitive: z.boolean(),
    dimensionScope: z.enum(['all', 'specific']),
    dimensionCodes: z.array(z.string()),
    mandatoryDenyExempt: z.literal(false),
  }).strict()),
  thresholds: z.array(z.object({
    dimensionId: z.string(),
    warn: z.number().min(0).max(1),
    block: z.number().min(0).max(1),
    autoMask: z.boolean(),
    autoRewrite: z.boolean(),
  }).strict()),
}).strict();

export interface RuntimePolicyBundle {
  readonly id: string;
  readonly generation: number;
  readonly payload: CompiledPolicyBundle;
}

const lastKnownGood = new Map<string, RuntimePolicyBundle>();

function cacheKey(scope: TenantScope, routingKey: string): string {
  return `${scope.tenantId}:${scope.applicationId}:${routingKey}`;
}

export function selectBoundBundleId(
  binding: Pick<
    typeof applicationPolicyBindings.$inferSelect,
    'activeBundleId' | 'canaryBundleId' | 'canaryPercent'
  >,
  routingKey: string,
): string | undefined {
  if (!binding.activeBundleId) return undefined;
  if (!binding.canaryBundleId || binding.canaryPercent <= 0) return binding.activeBundleId;
  const bucket = createHash('sha256').update(routingKey).digest().readUInt32BE(0) % 100;
  return bucket < binding.canaryPercent ? binding.canaryBundleId : binding.activeBundleId;
}

export async function loadRuntimePolicyBundle(
  scope: TenantScope,
  requestedBundleId?: string,
  routingKey = 'default',
): Promise<RuntimePolicyBundle> {
  const key = cacheKey(scope, routingKey);
  try {
    const [binding] = await db.select().from(applicationPolicyBindings)
      .where(scopePredicate(applicationPolicyBindings, scope)).limit(1);
    if (!binding) throw new Error('No policy binding exists');
    const bundleId = selectBoundBundleId(binding, routingKey);
    const generation = binding.generation;
    if (requestedBundleId && requestedBundleId !== bundleId) {
      throw new Error('Requested policy bundle does not match the data-plane selection');
    }
    if (!bundleId) throw new Error('No active policy bundle');
    const verified = await loadVerifiedPolicyBundle(scope, bundleId);
    const result = { ...verified, generation };
    lastKnownGood.set(key, result);
    return result;
  } catch (error) {
    const cached = lastKnownGood.get(key);
    if (cached) return cached;
    throw error;
  }
}

export async function loadVerifiedPolicyBundle(
  scope: TenantScope,
  bundleId: string,
  options: { readonly allowPreRelease?: boolean } = {},
): Promise<RuntimePolicyBundle> {
  const [row] = await db.select().from(policyBundles).where(and(
    eq(policyBundles.id, bundleId),
    scopePredicate(policyBundles, scope),
  )).limit(1);
  const allowedStates = options.allowPreRelease
    ? ['draft', 'testing', 'pending_approval', 'approved', 'shadow', 'canary', 'active', 'retired']
    : ['approved', 'shadow', 'canary', 'active', 'retired'];
  if (!row || !allowedStates.includes(row.state)) {
    throw new Error('Policy bundle is unavailable');
  }
  const payload = payloadSchema.parse(row.canonicalJson) as CompiledPolicyBundle;
  if (!verifyPolicyBundle({
    payload,
    contentHash: row.contentHash,
    signature: row.signature,
  }, verificationPublicKey())) {
    throw new Error('Policy bundle signature verification failed');
  }
  return { id: row.id, generation: 0, payload };
}

export function clearRuntimePolicyBundleCache(): void {
  lastKnownGood.clear();
}
import { createHash } from 'node:crypto';
