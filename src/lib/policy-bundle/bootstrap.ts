import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDefaultPolicyId, getPolicyConfig } from '@/lib/detection/dynamic-engine';
import { parseSemanticClassifierBuildConfig } from '@/lib/guard-engine-v2/semantic-classifier';
import { parseGuardResourceAdmissionBuildConfig } from '@/lib/resource-control/admission-config';
import { db } from '@/storage/database/shared/db';
import {
  applicationPolicyBindings,
  policyBundles,
  policyBundleTransitions,
} from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { canonicalJson } from './canonical';
import { compilePolicyBundle } from './compiler';
import {
  policyPublicKeyFingerprint,
  policySigningKeyId,
  signPolicyBundle,
  signingPrivateKey,
  verificationPublicKey,
  verifyPolicyBundle,
} from './crypto';
import { clearRuntimePolicyBundleCache } from './runtime';
import type { CompiledPolicyBundle } from './types';

const LOCAL_BOOTSTRAP_PROFILE = 'local-compose';
const LOCAL_BOOTSTRAP_ASSURANCE = 'operator-attested-development-only';
const BOOTSTRAP_BUILDER = 'guardllm-local-bootstrap-builder';
const BOOTSTRAP_TESTER = 'guardllm-local-bootstrap-self-test';
const BOOTSTRAP_APPROVER = 'guardllm-local-bootstrap-operator';

export interface PolicyBootstrapSummary {
  readonly reused: boolean;
  readonly bundleId: string;
  readonly generation: number;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly contentHash: string;
  readonly signingKeyId: string;
  readonly publicKeyFingerprint: string;
  readonly dimensionCount: number;
  readonly ruleCount: number;
  readonly thresholdCount: number;
  readonly applicationBound: true;
  readonly deploymentProfile: typeof LOCAL_BOOTSTRAP_PROFILE;
  readonly assuranceLevel: typeof LOCAL_BOOTSTRAP_ASSURANCE;
  readonly externalApproval: false;
}

export interface BootstrapPayloadSummary {
  readonly dimensionCount: number;
  readonly ruleCount: number;
  readonly thresholdCount: number;
}

export function assertLocalDevelopmentBootstrap(input: {
  readonly acknowledged: boolean;
  readonly databaseUrl: string | undefined;
  readonly deploymentProfile: string | undefined;
}): void {
  if (!input.acknowledged) {
    throw new Error('Local policy bootstrap requires explicit --allow-local-development acknowledgement');
  }
  if (input.deploymentProfile !== LOCAL_BOOTSTRAP_PROFILE) {
    throw new Error('Local policy bootstrap requires GUARDLLM_DEPLOYMENT_PROFILE=local-compose');
  }
  if (!input.databaseUrl) throw new Error('DATABASE_URL is required for policy bootstrap');
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(input.databaseUrl);
  } catch (error) {
    throw new Error('DATABASE_URL is invalid', { cause: error });
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('Local policy bootstrap only supports PostgreSQL URLs');
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!loopbackHosts.has(databaseUrl.hostname.toLowerCase())) {
    throw new Error('Local policy bootstrap refuses non-loopback databases');
  }
}

export function validateBootstrapPolicyPayload(
  payload: CompiledPolicyBundle,
): BootstrapPayloadSummary {
  if (payload.schemaVersion !== '1.0') throw new Error('Unsupported policy bundle schema version');
  const dimensionCodes = new Set(payload.dimensions.map((dimension) => dimension.code));
  const dimensionIds = new Set(payload.dimensions.map((dimension) => dimension.id));
  if (dimensionCodes.size !== payload.dimensions.length || dimensionIds.size !== payload.dimensions.length) {
    throw new Error('Policy bundle dimensions must be unique');
  }
  if (payload.dimensions.length < 16) {
    throw new Error('Default policy bundle must contain at least 16 detection dimensions');
  }
  const ruleDimensions = new Set(payload.rules.map((rule) => rule.riskType));
  const missingRuleDimensions = [...dimensionCodes].filter((code) => !ruleDimensions.has(code));
  if (missingRuleDimensions.length > 0) {
    throw new Error('Default policy bundle must contain an executable rule for every dimension');
  }
  const thresholdDimensions = new Set(payload.thresholds.map((threshold) => threshold.dimensionId));
  const missingThresholds = [...dimensionIds].filter((id) => !thresholdDimensions.has(id));
  if (missingThresholds.length > 0) {
    throw new Error('Default policy bundle must contain an action threshold for every dimension');
  }
  if (!payload.detectorDag || payload.detectorDag.nodes.length === 0) {
    throw new Error('Default policy bundle must contain a detector DAG and failure policies');
  }
  return {
    dimensionCount: payload.dimensions.length,
    ruleCount: payload.rules.length,
    thresholdCount: payload.thresholds.length,
  };
}

export function policyPayloadContentHash(
  payload: CompiledPolicyBundle,
): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function verifyStoredBootstrapBundle(
  bundle: typeof policyBundles.$inferSelect,
): BootstrapPayloadSummary {
  if (bundle.state !== 'active') throw new Error('Existing policy binding is not active');
  if (bundle.signatureAlgorithm !== 'Ed25519') throw new Error('Existing policy bundle algorithm is not trusted');
  if (bundle.signingKeyId !== policySigningKeyId()) throw new Error('Existing policy bundle Key ID is not trusted');
  const payload = bundle.canonicalJson as unknown as CompiledPolicyBundle;
  const summary = validateBootstrapPolicyPayload(payload);
  if (!verifyPolicyBundle({
    payload,
    contentHash: bundle.contentHash,
    signature: bundle.signature,
  }, verificationPublicKey())) {
    throw new Error('Existing active policy bundle signature verification failed');
  }
  return summary;
}

function summary(input: {
  readonly reused: boolean;
  readonly bundle: typeof policyBundles.$inferSelect;
  readonly generation: number;
  readonly payload: BootstrapPayloadSummary;
}): PolicyBootstrapSummary {
  return {
    reused: input.reused,
    bundleId: input.bundle.id,
    generation: input.generation,
    policyId: input.bundle.policyId,
    policyVersion: input.bundle.version,
    contentHash: input.bundle.contentHash,
    signingKeyId: input.bundle.signingKeyId,
    publicKeyFingerprint: policyPublicKeyFingerprint(),
    ...input.payload,
    applicationBound: true,
    deploymentProfile: LOCAL_BOOTSTRAP_PROFILE,
    assuranceLevel: LOCAL_BOOTSTRAP_ASSURANCE,
    externalApproval: false,
  };
}

export async function bootstrapLocalDefaultPolicyBundle(
  scope: TenantScope,
): Promise<PolicyBootstrapSummary> {
  const policyId = await getDefaultPolicyId(scope);
  if (!policyId) throw new Error('No active default policy exists in the requested scope');
  const config = await getPolicyConfig(policyId, scope);
  if (!config) throw new Error('Default policy has no executable detection configuration');

  const compileOptions = {
    semanticClassifier: parseSemanticClassifierBuildConfig(),
    resourceAdmission: parseGuardResourceAdmissionBuildConfig(),
  };

  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`local-policy-bootstrap:${scope.tenantId}:${scope.applicationId}`}))`);
    let replacedBundle: typeof policyBundles.$inferSelect | undefined;
    const [binding] = await transaction.select().from(applicationPolicyBindings)
      .where(scopePredicate(applicationPolicyBindings, scope)).limit(1).for('update');

    if (binding?.activeBundleId) {
      const [active] = await transaction.select().from(policyBundles).where(and(
        eq(policyBundles.id, binding.activeBundleId),
        scopePredicate(policyBundles, scope),
      )).limit(1).for('update');
      if (!active) throw new Error('Existing policy binding points to a missing bundle');
      if (active.policyId !== policyId) {
        throw new Error('Existing active bundle does not match the default policy');
      }
      const activeSummary = verifyStoredBootstrapBundle(active);
      const currentPayload = compilePolicyBundle(
        config,
        active.version,
        compileOptions,
      );
      validateBootstrapPolicyPayload(currentPayload);
      if (policyPayloadContentHash(currentPayload) === active.contentHash) {
        return summary({
          reused: true,
          bundle: active,
          generation: binding.generation,
          payload: activeSummary,
        });
      }
      replacedBundle = active;
    }

    const [latest] = await transaction.select({ version: policyBundles.version })
      .from(policyBundles)
      .where(and(eq(policyBundles.policyId, policyId), scopePredicate(policyBundles, scope)))
      .orderBy(desc(policyBundles.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const payload = compilePolicyBundle(config, version, compileOptions);
    const payloadSummary = validateBootstrapPolicyPayload(payload);
    const signed = signPolicyBundle(payload, {
      privateKey: signingPrivateKey(),
      signingKeyId: policySigningKeyId(),
    });
    if (!verifyPolicyBundle(signed, verificationPublicKey())) {
      throw new Error('New policy bundle failed the signing self-test');
    }

    const now = new Date();
    const [created] = await transaction.insert(policyBundles).values({
      ...scope,
      policyId,
      version,
      state: 'active',
      lifecycleVersion: 5,
      canonicalJson: signed.payload as unknown as Record<string, unknown>,
      contentHash: signed.contentHash,
      signature: signed.signature,
      signatureAlgorithm: signed.signatureAlgorithm,
      signingKeyId: signed.signingKeyId,
      createdBy: BOOTSTRAP_BUILDER,
      testedBy: BOOTSTRAP_TESTER,
      testedAt: now,
      approvedBy: BOOTSTRAP_APPROVER,
      approvedAt: now,
      activatedAt: now,
    }).returning();
    if (!created) throw new Error('Policy bundle insert returned no row');

    const transitionMetadata = {
      assuranceLevel: LOCAL_BOOTSTRAP_ASSURANCE,
      deploymentProfile: LOCAL_BOOTSTRAP_PROFILE,
      externalApproval: false,
      operatorAcknowledgementRequired: true,
      dimensionCount: payloadSummary.dimensionCount,
      ruleCount: payloadSummary.ruleCount,
      thresholdCount: payloadSummary.thresholdCount,
      publicKeyFingerprint: policyPublicKeyFingerprint(),
    };
    await transaction.insert(policyBundleTransitions).values([
      {
        ...scope, bundleId: created.id, fromState: null, toState: 'draft',
        action: 'compile', actorId: BOOTSTRAP_BUILDER, lifecycleVersion: 1,
        metadata: transitionMetadata,
      },
      {
        ...scope, bundleId: created.id, fromState: 'draft', toState: 'testing',
        action: 'local_self_test', actorId: BOOTSTRAP_TESTER, lifecycleVersion: 2,
        metadata: transitionMetadata,
      },
      {
        ...scope, bundleId: created.id, fromState: 'testing', toState: 'pending_approval',
        action: 'local_test_pass', actorId: BOOTSTRAP_TESTER, lifecycleVersion: 3,
        metadata: transitionMetadata,
      },
      {
        ...scope, bundleId: created.id, fromState: 'pending_approval', toState: 'approved',
        action: 'local_attest', actorId: BOOTSTRAP_APPROVER, lifecycleVersion: 4,
        metadata: transitionMetadata,
      },
      {
        ...scope, bundleId: created.id, fromState: 'approved', toState: 'active',
        action: 'bootstrap_activate', actorId: BOOTSTRAP_APPROVER, lifecycleVersion: 5,
        metadata: transitionMetadata,
      },
    ]);

    const generation = (binding?.generation ?? 0) + 1;
    const bindingValues = {
      ...scope,
      activeBundleId: created.id,
      previousBundleId: binding?.activeBundleId ?? null,
      shadowBundleId: null,
      canaryBundleId: null,
      canaryPercent: 0,
      generation,
      updatedBy: BOOTSTRAP_APPROVER,
      updatedAt: now,
    };
    await transaction.insert(applicationPolicyBindings).values(bindingValues).onConflictDoUpdate({
      target: [applicationPolicyBindings.tenantId, applicationPolicyBindings.applicationId],
      set: {
        activeBundleId: bindingValues.activeBundleId,
        previousBundleId: bindingValues.previousBundleId,
        shadowBundleId: bindingValues.shadowBundleId,
        canaryBundleId: bindingValues.canaryBundleId,
        canaryPercent: bindingValues.canaryPercent,
        generation: bindingValues.generation,
        updatedBy: bindingValues.updatedBy,
        updatedAt: bindingValues.updatedAt,
      },
    });

    if (replacedBundle) {
      const retiredVersion = replacedBundle.lifecycleVersion + 1;
      const retired = await transaction.update(policyBundles).set({
        state: 'retired',
        lifecycleVersion: retiredVersion,
      }).where(and(
        eq(policyBundles.id, replacedBundle.id),
        eq(policyBundles.lifecycleVersion, replacedBundle.lifecycleVersion),
        scopePredicate(policyBundles, scope),
      )).returning({ id: policyBundles.id });
      if (retired.length !== 1) {
        throw new Error('Existing active policy bundle changed during local rotation');
      }
      await transaction.insert(policyBundleTransitions).values({
        ...scope,
        bundleId: replacedBundle.id,
        fromState: replacedBundle.state,
        toState: 'retired',
        action: 'replaced',
        actorId: BOOTSTRAP_APPROVER,
        reason: `Replaced by local bootstrap bundle ${created.id}`,
        lifecycleVersion: retiredVersion,
        metadata: { ...transitionMetadata, replacedByBundleId: created.id },
      });
    }

    return summary({ reused: false, bundle: created, generation, payload: payloadSummary });
  });
  clearRuntimePolicyBundleCache();
  return result;
}
