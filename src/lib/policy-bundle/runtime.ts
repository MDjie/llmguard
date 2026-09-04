import { createHash, type KeyObject } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import {
  applicationPolicyBindings,
  policyBundles,
} from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { policySigningKeyId, verificationPublicKey, verifyPolicyBundle } from './crypto';
import { recordPolicyIntegrityFailure } from './integrity-events';
import {
  isTransientPolicyDatabaseError,
  policyLastKnownGoodMaxAgeMs,
  PolicyBundleRuntimeError,
} from './runtime-error';
import type { CompiledPolicyBundle } from './types';
import { semanticClassifierSpecSchema } from '@/lib/guard-engine-v2/semantic-classifier';
import { guardResourceAdmissionSpecSchema } from '@/lib/resource-control/admission-config';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const ruleSchema = z.object({
  id: z.string(),
  riskType: z.string(),
  pattern: z.string(),
  matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']),
  caseSensitive: z.boolean(),
  score: z.number().min(0).max(1),
  severity: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  ruleVersion: z.string().optional(),
  mandatoryDeny: z.boolean().optional(),
  canonicalTermId: z.string().optional(),
  variantId: z.string().optional(),
  dictionaryReleaseId: z.string().optional(),
  dictionaryVersion: z.string().optional(),
  owner: z.string().optional(),
  locale: z.string().optional(),
  direction: z.enum([
    'BOTH',
    'INPUT',
    'OUTPUT_COMPLETE',
    'OUTPUT_CHUNK',
    'RAG_INGEST',
    'RAG_CONTEXT',
    'TOOL_REQUEST',
    'TOOL_RESULT',
  ]).optional(),
  industry: z.string().optional(),
  contexts: z.array(z.string()).optional(),
  validFromEpochMs: z.number().int().positive().optional(),
  validToEpochMs: z.number().int().positive().optional(),
  evidenceRequirement: z.string().optional(),
}).strict();
const detectorDagSchema = z.object({
  version: z.string().min(1).max(128),
  maximumCostUnits: z.number().int().positive().max(10_000),
  nodes: z.array(z.object({
    id: z.string().min(1).max(128),
    detectorId: z.string().min(1).max(128),
    tier: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
    dependsOn: z.array(z.string().min(1).max(128)).max(64),
    runCondition: z.enum([
      'ALWAYS',
      'WHEN_PARENT_MATCHES',
      'WHEN_PARENT_FAILS',
      'WHEN_NO_BLOCKING_MATCH',
    ]),
    timeoutMs: z.number().int().positive().max(60_000),
    maxAttempts: z.number().int().min(1).max(3),
    costUnits: z.number().int().positive().max(10_000),
    failurePolicy: z.enum(['FAIL_CLOSED', 'DEGRADE']),
  }).strict()).min(1).max(128),
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
    targetRuleIds: z.array(z.string().min(1)).min(1).max(5_000).optional(),
    directions: z.array(z.enum([
      'INPUT',
      'OUTPUT_COMPLETE',
      'OUTPUT_CHUNK',
      'RAG_INGEST',
      'RAG_CONTEXT',
      'TOOL_REQUEST',
      'TOOL_RESULT',
    ])).min(1).max(7).optional(),
    validFromEpochMs: z.number().int().positive().optional(),
    expiresAtEpochMs: z.number().int().positive().optional(),
    approvalStatus: z.literal('approved').optional(),
    approvedBy: z.string().min(1).max(255).optional(),
    mandatoryDenyExempt: z.literal(false),
  }).strict()),
  thresholds: z.array(z.object({
    dimensionId: z.string(),
    warn: z.number().min(0).max(1),
    block: z.number().min(0).max(1),
    autoMask: z.boolean(),
    autoRewrite: z.boolean(),
  }).strict()),
  detectorDag: detectorDagSchema.optional(),
  semanticClassifier: semanticClassifierSpecSchema().optional(),
  resourceAdmission: guardResourceAdmissionSpecSchema().optional(),
  dictionaryReleases: z.array(z.object({
    id: z.string(),
    dictionaryId: z.string(),
    version: z.string(),
    state: z.enum(['reviewed', 'shadow', 'canary', 'active']),
    manifestHash: sha256Schema,
    contentHash: sha256Schema,
    signatureAlgorithm: z.literal('Ed25519'),
    signingKeyId: z.string(),
    entryCount: z.number().int().nonnegative(),
    submittedBy: z.string().min(1),
    approvedBy: z.string().min(1),
  }).strict()).optional(),
  responseTemplates: z.array(z.object({
    id: z.string(),
    templateKey: z.string(),
    riskCategory: z.string(),
    action: z.enum([
      'WARN',
      'MASK',
      'REWRITE',
      'REQUIRE_REVIEW',
      'SAFE_RESPONSE',
      'BLOCK',
    ]),
    locale: z.string(),
    industry: z.string(),
    templateText: z.string(),
    allowedVariables: z.array(z.string()),
    version: z.number().int().positive(),
    contentHash: sha256Schema,
    signatureDigest: sha256Schema,
    approvedBy: z.string().min(1),
  }).strict()).optional(),
  detectorCalibrations: z.array(z.object({
    id: z.string(),
    detectorId: z.string(),
    detectorVersion: z.string(),
    riskType: z.string(),
    locale: z.string(),
    industry: z.string(),
    threshold: z.number().min(0).max(1),
    confidenceFloor: z.number().min(0).max(1),
    metrics: z.record(z.string(), z.number()),
    datasetHash: sha256Schema,
    approvedBy: z.string().min(1),
  }).strict()).optional(),
  modelDigests: z.array(z.object({
    modelId: z.string(),
    modelVersion: z.string(),
    sha256: sha256Schema,
  }).strict()).optional(),
  tokenizer: z.object({
    id: z.string(),
    version: z.string(),
    sha256: sha256Schema,
  }).strict().optional(),
  failurePolicies: z.array(z.object({
    detectorId: z.string(),
    policy: z.enum(['FAIL_CLOSED', 'DEGRADE']),
  }).strict()).optional(),
}).strict();

export function parseCompiledPolicyBundlePayload(value: unknown): CompiledPolicyBundle {
  return payloadSchema.parse(value) as CompiledPolicyBundle;
}

export interface RuntimePolicyBundle {
  readonly id: string;
  readonly generation: number;
  readonly payload: CompiledPolicyBundle;
}

interface CachedRuntimePolicyBundle {
  readonly bundle: RuntimePolicyBundle;
  readonly verifiedAt: number;
}

const lastKnownGood = new Map<string, CachedRuntimePolicyBundle>();

function cacheKey(scope: TenantScope, routingKey: string): string {
  return `${scope.tenantId}:${scope.applicationId}:${routingKey}`;
}

function databaseFailure(error: unknown): PolicyBundleRuntimeError {
  return new PolicyBundleRuntimeError(
    'POLICY_DATABASE_UNAVAILABLE',
    'Policy storage is unavailable',
    isTransientPolicyDatabaseError(error),
    { cause: error },
  );
}

function requireTrustedSigningMetadata(row: {
  readonly signatureAlgorithm: string;
  readonly signingKeyId: string;
}): void {
  if (row.signatureAlgorithm !== 'Ed25519') {
    throw new PolicyBundleRuntimeError(
      'POLICY_SIGNING_ALGORITHM_UNTRUSTED',
      'Policy bundle signing algorithm is not trusted',
    );
  }
  let configuredKeyId: string;
  try {
    configuredKeyId = policySigningKeyId();
  } catch (error) {
    throw new PolicyBundleRuntimeError(
      'POLICY_SIGNING_KEY_UNTRUSTED',
      'Policy verification key identity is unavailable',
      false,
      { cause: error },
    );
  }
  if (row.signingKeyId !== configuredKeyId) {
    throw new PolicyBundleRuntimeError(
      'POLICY_SIGNING_KEY_UNTRUSTED',
      'Policy bundle signing key is not trusted',
    );
  }
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
    let binding: typeof applicationPolicyBindings.$inferSelect | undefined;
    try {
      [binding] = await db.select().from(applicationPolicyBindings)
        .where(scopePredicate(applicationPolicyBindings, scope)).limit(1);
    } catch (error) {
      throw databaseFailure(error);
    }
    if (!binding) {
      throw new PolicyBundleRuntimeError('POLICY_BINDING_MISSING', 'No policy binding exists');
    }
    const bundleId = selectBoundBundleId(binding, routingKey);
    if (requestedBundleId && requestedBundleId !== bundleId) {
      throw new PolicyBundleRuntimeError(
        'POLICY_BUNDLE_POLICY_MISMATCH',
        'Requested policy bundle does not match the data-plane selection',
      );
    }
    if (!bundleId) {
      throw new PolicyBundleRuntimeError('POLICY_BUNDLE_MISSING', 'No active policy bundle exists');
    }
    const verified = await loadVerifiedPolicyBundle(scope, bundleId);
    const result = { ...verified, generation: binding.generation };
    lastKnownGood.set(key, { bundle: result, verifiedAt: Date.now() });
    return result;
  } catch (error) {
    if (
      error instanceof PolicyBundleRuntimeError &&
      error.code === 'POLICY_DATABASE_UNAVAILABLE' &&
      error.recoverable
    ) {
      const cached = lastKnownGood.get(key);
      if (cached && Date.now() - cached.verifiedAt <= policyLastKnownGoodMaxAgeMs()) {
        return cached.bundle;
      }
      if (cached) {
        throw new PolicyBundleRuntimeError(
          'POLICY_LAST_KNOWN_GOOD_EXPIRED',
          'The last verified policy bundle has expired',
          false,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export async function loadVerifiedPolicyBundle(
  scope: TenantScope,
  bundleId: string,
  options: { readonly allowPreRelease?: boolean } = {},
): Promise<RuntimePolicyBundle> {
  let row: typeof policyBundles.$inferSelect | undefined;
  try {
    [row] = await db.select().from(policyBundles).where(and(
      eq(policyBundles.id, bundleId),
      scopePredicate(policyBundles, scope),
    )).limit(1);
  } catch (error) {
    throw databaseFailure(error);
  }
  if (!row) {
    throw new PolicyBundleRuntimeError('POLICY_BUNDLE_MISSING', 'Policy bundle does not exist');
  }
  const allowedStates = options.allowPreRelease
    ? ['draft', 'testing', 'pending_approval', 'approved', 'shadow', 'canary', 'active', 'retired']
    : ['approved', 'shadow', 'canary', 'active', 'retired'];
  if (!allowedStates.includes(row.state)) {
    throw new PolicyBundleRuntimeError(
      'POLICY_BUNDLE_STATE_INVALID',
      'Policy bundle state is not executable',
    );
  }
  requireTrustedSigningMetadata(row);
  let payload: CompiledPolicyBundle;
  try {
    payload = parseCompiledPolicyBundlePayload(row.canonicalJson);
  } catch (error) {
    await recordPolicyIntegrityFailure({
      failure: 'POLICY_DIGEST_MISMATCH',
      scope,
      bundleId: row.id,
      detailCode: 'POLICY_BUNDLE_SCHEMA_INVALID',
    }).catch(() => undefined);
    throw new PolicyBundleRuntimeError(
      'POLICY_BUNDLE_SCHEMA_INVALID',
      'Policy bundle schema validation failed',
      false,
      { cause: error },
    );
  }
  let publicKey: KeyObject;
  try {
    publicKey = verificationPublicKey();
  } catch (error) {
    throw new PolicyBundleRuntimeError(
      'POLICY_SIGNING_KEY_UNTRUSTED',
      'Policy verification key is unavailable',
      false,
      { cause: error },
    );
  }
  if (!verifyPolicyBundle({
    payload,
    contentHash: row.contentHash,
    signature: row.signature,
  }, publicKey)) {
    await recordPolicyIntegrityFailure({
      failure: 'POLICY_DIGEST_MISMATCH',
      scope,
      bundleId: row.id,
      detailCode: 'POLICY_SIGNATURE_INVALID',
    }).catch(() => undefined);
    throw new PolicyBundleRuntimeError(
      'POLICY_SIGNATURE_INVALID',
      'Policy bundle signature verification failed',
    );
  }
  return { id: row.id, generation: 0, payload };
}

export async function loadLatestVerifiedPolicyBundleForPolicy(
  scope: TenantScope,
  policyId: string,
  options: { readonly allowPreRelease?: boolean; readonly routingKey?: string } = {},
): Promise<RuntimePolicyBundle> {
  if (!options.allowPreRelease) {
    const selected = await loadRuntimePolicyBundle(scope, undefined, options.routingKey ?? policyId);
    if (selected.payload.policyId !== policyId) {
      throw new PolicyBundleRuntimeError(
        'POLICY_BUNDLE_POLICY_MISMATCH',
        'The active policy bundle does not contain the requested policy',
      );
    }
    return selected;
  }

  const allowedStates = new Set([
    'draft',
    'testing',
    'pending_approval',
    'approved',
    'shadow',
    'canary',
    'active',
  ]);
  let rows: Array<{ readonly id: string; readonly state: string }>;
  try {
    rows = await db.select({
      id: policyBundles.id,
      state: policyBundles.state,
    }).from(policyBundles).where(and(
      eq(policyBundles.policyId, policyId),
      scopePredicate(policyBundles, scope),
    )).orderBy(desc(policyBundles.version));
  } catch (error) {
    throw databaseFailure(error);
  }
  const selected = rows.find((row) => allowedStates.has(row.state));
  if (!selected) {
    throw new PolicyBundleRuntimeError('POLICY_BUNDLE_MISSING', 'Policy bundle is unavailable');
  }
  return loadVerifiedPolicyBundle(scope, selected.id, options);
}

export function clearRuntimePolicyBundleCache(): void {
  lastKnownGood.clear();
}
