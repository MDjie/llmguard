import { and, inArray } from 'drizzle-orm';
import type { GuardDecision, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle, evaluateWithSessionContext } from '@/lib/guard-engine-v2';
import { readSecureMemorySnapshot } from '@/lib/secure-memory';
import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
import { observePolicyBundleGeneration, observeShadowComparison } from '@/lib/observability/metrics';
import {
  inspectPolicyReadiness,
  isPolicyBundleRuntimeError,
  loadVerifiedPolicyBundle,
} from '@/lib/policy-bundle';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applicationPolicyBindings, policyBundles } from '@/storage/database/shared/schema';
import { PolicyGovernanceOperationError } from './errors';
import { profileDigest } from '@/lib/judge/profile-registry';

function digestSummary(bundle: Awaited<ReturnType<typeof loadVerifiedPolicyBundle>>) {
  const dictionaryDigests = (bundle.payload.dictionaryReleases ?? []).map((release) => ({
    id: release.dictionaryId,
    version: release.version,
    sha256: release.contentHash,
  }));
  const explicitModels = bundle.payload.modelDigests ?? [];
  const semantic = bundle.payload.semanticClassifier
    ? [{
        modelId: bundle.payload.semanticClassifier.modelId,
        modelVersion: bundle.payload.semanticClassifier.modelVersion,
        sha256: bundle.payload.semanticClassifier.modelSha256,
      }]
    : [];
  const modelDigests = [...explicitModels, ...semantic]
    .filter((item, index, all) => all.findIndex((candidate) =>
      candidate.modelId === item.modelId && candidate.modelVersion === item.modelVersion) === index)
    .map((item) => ({ id: item.modelId, version: item.modelVersion, sha256: item.sha256 }));
  return {
    dictionaryDigests,
    modelDigests,
    semanticDecisionMode:bundle.payload.semanticDecisionMode??'legacy',
    requiredRiskIds:bundle.payload.semanticCoverage?.requiredRiskIds??[],
    modelRoles:(bundle.payload.judgeProfiles??[]).map(p=>({profileId:p.profileId,role:p.role??'base',contextScope:p.contextScope??'full',riskIds:p.riskIds,directions:p.directions})),
    judgeProfiles: (bundle.payload.judgeProfiles ?? []).map(p=>({profileId:p.profileId,revision:p.revision,displayName:p.displayName,enabled:p.enabled,mode:p.mode,modelId:p.modelId,modelRevision:p.modelRevision,deploymentMode:p.deploymentMode,configurationDigest:profileDigest(p),weightsSha256:p.weightsSha256,qualityEvidenceId:p.qualityEvidenceId ?? null,qualityValidUntil:p.qualityValidUntil ?? null})),
    tokenizerDigest: bundle.payload.tokenizer
      ? {
          id: bundle.payload.tokenizer.id,
          version: bundle.payload.tokenizer.version,
          sha256: bundle.payload.tokenizer.sha256,
        }
      : null,
  };
}

export async function getPolicyRuntimeSummary(scope: TenantScope) {
  const [binding] = await db.select().from(applicationPolicyBindings)
    .where(scopePredicate(applicationPolicyBindings, scope)).limit(1);
  if (!binding || !binding.activeBundleId) {
    return {
      ready: false,
      reasonCode: binding ? 'POLICY_BUNDLE_MISSING' : 'POLICY_BINDING_MISSING',
      generation: binding?.generation ?? 0,
      binding: null,
      governedDigests: { dictionaryDigests: [], modelDigests: [], tokenizerDigest: null },
    };
  }
  const bundleIds = [
    binding.activeBundleId,
    binding.shadowBundleId,
    binding.canaryBundleId,
    binding.previousBundleId,
  ].filter((id): id is string => Boolean(id));
  const rows = await db.select({
    id: policyBundles.id,
    version: policyBundles.version,
    state: policyBundles.state,
    contentHash: policyBundles.contentHash,
    signingKeyId: policyBundles.signingKeyId,
    policyId: policyBundles.policyId,
  }).from(policyBundles).where(and(
    scopePredicate(policyBundles, scope),
    inArray(policyBundles.id, bundleIds),
  ));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const summary = (id: string | null) => id ? byId.get(id) ?? null : null;
  // An active bundle that cannot be verified (e.g. signing-key identity is not
  // configured) must surface as NOT READY with a reason code, not as a 500
  // that takes the release console's runtime card down.
  let active: Awaited<ReturnType<typeof loadVerifiedPolicyBundle>> | null = null;
  let signatureVerified = true;
  let verificationReason: string | null = null;
  try {
    active = await loadVerifiedPolicyBundle(scope, binding.activeBundleId);
  } catch (error) {
    signatureVerified = false;
    verificationReason = isPolicyBundleRuntimeError(error) ? error.code : 'POLICY_BUNDLE_VERIFICATION_FAILED';
  }
  let readiness: Awaited<ReturnType<typeof inspectPolicyReadiness>> | null = null;
  let readinessReason: string | null = null;
  try {
    readiness = await inspectPolicyReadiness(scope);
  } catch (error) {
    readinessReason = isPolicyBundleRuntimeError(error) ? error.code : 'POLICY_READINESS_FAILED';
  }
  observePolicyBundleGeneration({ generation: binding.generation, tenantId: scope.tenantId, applicationId: scope.applicationId });
  return {
    ready: readiness?.ready ?? false,
    reasonCode: readinessReason ?? verificationReason,
    generation: binding.generation,
    assurance: readiness?.assurance ?? null,
    signatureVerified,
    binding: {
      active: summary(binding.activeBundleId),
      shadow: summary(binding.shadowBundleId),
      canary: summary(binding.canaryBundleId),
      previous: summary(binding.previousBundleId),
      canaryPercent: binding.canaryPercent,
      updatedAt: binding.updatedAt,
    },
    governedDigests: active ? digestSummary(active) : { dictionaryDigests: [], modelDigests: [], tokenizerDigest: null },
  };
}

function matchedRisks(decision: GuardDecision): readonly string[] {
  return [...new Set(decision.observations
    .filter(isConfirmedObservation)
    .map((item) => item.riskType))].sort();
}

export function compareShadowDecisions(input: {
  readonly active: GuardDecision;
  readonly shadow: GuardDecision;
  readonly activeLatencyMs: number;
  readonly shadowLatencyMs: number;
}) {
  const activeRisks = matchedRisks(input.active);
  const shadowRisks = matchedRisks(input.shadow);
  const activeRiskSet = new Set(activeRisks);
  const shadowRiskSet = new Set(shadowRisks);
  return {
    activeAction: input.active.action,
    shadowAction: input.shadow.action,
    actionChanged: input.active.action !== input.shadow.action,
    activeHitCount: activeRisks.length,
    shadowHitCount: shadowRisks.length,
    newRiskCategories: shadowRisks.filter((risk) => !activeRiskSet.has(risk)),
    missedRiskCategories: activeRisks.filter((risk) => !shadowRiskSet.has(risk)),
    activeLatencyMs: input.activeLatencyMs,
    shadowLatencyMs: input.shadowLatencyMs,
    latencyDeltaMs: input.shadowLatencyMs - input.activeLatencyMs,
  };
}

export async function evaluateShadowComparison(scope: TenantScope, request: GuardRequest) {
  if (request.context.tenantId !== scope.tenantId || request.context.applicationId !== scope.applicationId) {
    throw new PolicyGovernanceOperationError('SHADOW_SCOPE_MISMATCH', 'Shadow comparison scope does not match authentication.', 422);
  }
  if (request.content.text === undefined || request.context.absoluteDeadlineEpochMs <= Date.now()) {
    throw new PolicyGovernanceOperationError('SHADOW_REQUEST_INVALID', 'Shadow comparison requires text and a future deadline.', 422);
  }
  const [binding] = await db.select().from(applicationPolicyBindings)
    .where(scopePredicate(applicationPolicyBindings, scope)).limit(1);
  if (!binding?.activeBundleId || !binding.shadowBundleId) {
    throw new PolicyGovernanceOperationError('SHADOW_BINDING_MISSING', 'Both active and shadow bundles must be bound.');
  }
  const [activeBundle, shadowBundle] = await Promise.all([
    loadVerifiedPolicyBundle(scope, binding.activeBundleId),
    loadVerifiedPolicyBundle(scope, binding.shadowBundleId),
  ]);
  const snapshot=request.context.sessionId ? await readSecureMemorySnapshot(scope,request.context.sessionId) : undefined;
  const evaluate = async (
    bundle: typeof activeBundle,
    suffix: string,
  ): Promise<{ readonly decision: GuardDecision; readonly latencyMs: number }> => {
    const startedAt = performance.now();
    const decision = await evaluateWithSessionContext(createEngineForPolicyBundle(bundle),{
      ...request,
      context: {
        ...request.context,
        requestId: (request.context.requestId + '-' + suffix).slice(0, 128),
        policyBundleId: bundle.id,
      },
    },scope,{readOnly:true,snapshot});
    return { decision, latencyMs: Math.max(0, performance.now() - startedAt) };
  };
  const [active, shadow] = await Promise.all([
    evaluate(activeBundle, 'active'),
    evaluate(shadowBundle, 'shadow'),
  ]);
  const comparison = compareShadowDecisions({
    active: active.decision,
    shadow: shadow.decision,
    activeLatencyMs: active.latencyMs,
    shadowLatencyMs: shadow.latencyMs,
  });
  observeShadowComparison({
    actionChanged: comparison.actionChanged,
    activeHit: comparison.activeHitCount > 0,
    shadowHit: comparison.shadowHitCount > 0,
    latencyDeltaMs: comparison.latencyDeltaMs,
  });
  return {
    activeBundleId: activeBundle.id,
    shadowBundleId: shadowBundle.id,
    generation: binding.generation,
    ...comparison,
    sessionSnapshotVersion:snapshot?.stateVersion ?? null,
    sessionMemoryMutated:false,
  };
}
