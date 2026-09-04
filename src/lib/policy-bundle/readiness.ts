import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import {
  applicationPolicyBindings,
  policyBundles,
  policyBundleTransitions,
  policyProfiles,
} from '@/storage/database/shared/schema';
import { LEGACY_TENANT_SCOPE, scopePredicate, type TenantScope } from '@/lib/tenancy';
import { policyPublicKeyFingerprint } from './crypto';
import { loadVerifiedPolicyBundle } from './runtime';
import { PolicyBundleRuntimeError } from './runtime-error';

export interface PolicyReadinessReport {
  readonly ready: true;
  readonly service: 'guardllm';
  readonly bundleId: string;
  readonly generation: number;
  readonly publicKeyFingerprint: string;
  readonly signingKeyId: string;
  readonly signatureAlgorithm: 'Ed25519';
  readonly deploymentProfile: string;
  readonly assurance: {
    readonly level: 'production-approved' | 'operator-attested-development-only';
    readonly externalApproval: boolean;
  };
  readonly profile: {
    readonly id: string;
    readonly name: string;
    readonly version: number;
  };
  readonly applicationBinding: {
    readonly bound: true;
    readonly active: true;
  };
  readonly compilation: {
    readonly schemaVersion: '1.0';
    readonly contentHash: string;
    readonly dimensions: number;
    readonly rules: number;
    readonly thresholds: number;
    readonly detectorDagVersion: string | null;
  };
  readonly updatedAt: string;
}

export function resolvePolicyReleaseAssurance(
  activationAction: string | undefined,
  deploymentProfile: string,
): PolicyReadinessReport['assurance'] {
  if (activationAction === 'bootstrap_activate') {
    if (deploymentProfile !== 'local-compose' && deploymentProfile !== 'test') {
      throw new PolicyBundleRuntimeError(
        'POLICY_BUNDLE_ASSURANCE_INVALID',
        'Development-only policy bundle is not permitted in this deployment profile',
      );
    }
    return {
      level: 'operator-attested-development-only',
      externalApproval: false,
    };
  }
  if (activationAction !== 'activate' && activationAction !== 'rollback_restore') {
    throw new PolicyBundleRuntimeError(
      'POLICY_BUNDLE_ASSURANCE_INVALID',
      'Policy bundle activation evidence is unavailable',
    );
  }
  return { level: 'production-approved', externalApproval: true };
}

function databaseUnavailable(error: unknown): PolicyBundleRuntimeError {
  return new PolicyBundleRuntimeError(
    'POLICY_DATABASE_UNAVAILABLE',
    'Policy readiness storage is unavailable',
    false,
    { cause: error },
  );
}

export async function inspectPolicyReadiness(
  scope: TenantScope = LEGACY_TENANT_SCOPE,
): Promise<PolicyReadinessReport> {
  let profile: Pick<typeof policyProfiles.$inferSelect, 'id' | 'name' | 'version'> | undefined;
  let binding: typeof applicationPolicyBindings.$inferSelect | undefined;
  try {
    [[profile], [binding]] = await Promise.all([
      db.select({
        id: policyProfiles.id,
        name: policyProfiles.name,
        version: policyProfiles.version,
      }).from(policyProfiles).where(and(
        eq(policyProfiles.isDefault, true),
        eq(policyProfiles.isActive, true),
        scopePredicate(policyProfiles, scope),
      )).limit(1),
      db.select().from(applicationPolicyBindings)
        .where(scopePredicate(applicationPolicyBindings, scope)).limit(1),
    ]);
  } catch (error) {
    throw databaseUnavailable(error);
  }
  if (!profile) {
    throw new PolicyBundleRuntimeError(
      'POLICY_BUNDLE_MISSING',
      'No active default policy profile exists',
    );
  }
  if (!binding) {
    throw new PolicyBundleRuntimeError('POLICY_BINDING_MISSING', 'No application policy binding exists');
  }
  if (!binding.activeBundleId) {
    throw new PolicyBundleRuntimeError('POLICY_BUNDLE_MISSING', 'Application has no active policy bundle');
  }

  let bundle: typeof policyBundles.$inferSelect | undefined;
  let transition: Pick<typeof policyBundleTransitions.$inferSelect, 'action'> | undefined;
  try {
    [[bundle], [transition]] = await Promise.all([
      db.select().from(policyBundles).where(and(
        eq(policyBundles.id, binding.activeBundleId),
        scopePredicate(policyBundles, scope),
      )).limit(1),
      db.select({ action: policyBundleTransitions.action })
        .from(policyBundleTransitions)
        .where(and(
          eq(policyBundleTransitions.bundleId, binding.activeBundleId),
          scopePredicate(policyBundleTransitions, scope),
        ))
        .orderBy(desc(policyBundleTransitions.lifecycleVersion))
        .limit(1),
    ]);
  } catch (error) {
    throw databaseUnavailable(error);
  }
  if (!bundle) {
    throw new PolicyBundleRuntimeError('POLICY_BUNDLE_MISSING', 'Active policy bundle is missing');
  }
  if (bundle.state !== 'active') {
    throw new PolicyBundleRuntimeError('POLICY_BUNDLE_STATE_INVALID', 'Bound policy bundle is not active');
  }
  if (bundle.policyId !== profile.id) {
    throw new PolicyBundleRuntimeError(
      'POLICY_BUNDLE_POLICY_MISMATCH',
      'Active policy bundle does not match the default profile',
    );
  }
  const verified = await loadVerifiedPolicyBundle(scope, bundle.id);
  const deploymentProfile = process.env.GUARDLLM_DEPLOYMENT_PROFILE?.trim() || 'production';
  const assurance = resolvePolicyReleaseAssurance(transition?.action, deploymentProfile);

  return {
    ready: true,
    service: 'guardllm',
    bundleId: bundle.id,
    generation: binding.generation,
    publicKeyFingerprint: policyPublicKeyFingerprint(),
    signingKeyId: bundle.signingKeyId,
    signatureAlgorithm: 'Ed25519',
    deploymentProfile,
    assurance,
    profile,
    applicationBinding: { bound: true, active: true },
    compilation: {
      schemaVersion: verified.payload.schemaVersion,
      contentHash: bundle.contentHash,
      dimensions: verified.payload.dimensions.length,
      rules: verified.payload.rules.length,
      thresholds: verified.payload.thresholds.length,
      detectorDagVersion: verified.payload.detectorDag?.version ?? null,
    },
    updatedAt: binding.updatedAt.toISOString(),
  };
}
