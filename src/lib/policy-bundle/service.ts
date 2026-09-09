import { assertPublishableDetectionCapabilities } from './detection-capabilities';
import { parseCompiledPolicyBundlePayload } from './runtime';
import { synchronizeGatewayPublication } from '@/lib/gateway-runtime/publication';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import {
  applicationPolicyBindings,
  gatewayRuntimeSnapshots,
  evaluationRuns,
  policyBundles,
  policyBundleTransitions,
} from '@/storage/database/shared/schema';
import { getPolicyConfig } from '@/lib/detection/dynamic-engine';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { compilePolicyBundle } from './compiler';
import { loadGovernedPolicyArtifacts } from './governance';
import { policySigningKeyId, signPolicyBundle, signingPrivateKey } from './crypto';
import {
  evaluationGateViolations,
  nextPolicyBundleState,
  PolicyBundleTransitionError,
  resolvePolicyEvaluationGate,
  type BundleTransition,
  type PolicyBundleState,
} from './lifecycle';
import { clearRuntimePolicyBundleCache } from './runtime';
import { parseSemanticClassifierBuildConfig } from '@/lib/guard-engine-v2/semantic-classifier';
import { parseGuardResourceAdmissionBuildConfig } from '@/lib/resource-control/admission-config';
import { loadJudgeDraft } from '@/lib/judge/draft-service';

export { PolicyBundleTransitionError } from './lifecycle';
export type { BundleTransition } from './lifecycle';

export interface BundleTransitionOptions {
  readonly expectedVersion: number;
  readonly canaryPercent?: number;
  readonly evaluationRunId?: string;
  readonly reason?: string;
}

function transitionRecord(input: {
  readonly scope: TenantScope;
  readonly bundleId: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly action: string;
  readonly actorId: string;
  readonly lifecycleVersion: number;
  readonly reason?: string;
  readonly evidenceId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}) {
  return {
    tenantId: input.scope.tenantId,
    applicationId: input.scope.applicationId,
    bundleId: input.bundleId,
    fromState: input.fromState,
    toState: input.toState,
    action: input.action,
    actorId: input.actorId,
    reason: input.reason,
    evidenceId: input.evidenceId,
    lifecycleVersion: input.lifecycleVersion,
    metadata: { ...(input.metadata ?? {}) },
  };
}

export async function compileAndStorePolicyBundle(
  scope: TenantScope,
  policyId: string,
  actorId: string,
): Promise<typeof policyBundles.$inferSelect> {
  const payload = await compileCurrentPolicyDraft(scope, policyId, 1);
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`${scope.tenantId}:${scope.applicationId}:${policyId}`}))`);
    const [latest] = await transaction.select({ version: policyBundles.version })
      .from(policyBundles)
      .where(and(eq(policyBundles.policyId, policyId), scopePredicate(policyBundles, scope)))
      .orderBy(desc(policyBundles.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const signed = signPolicyBundle({ ...payload, policyVersion: version }, {
      privateKey: signingPrivateKey(),
      signingKeyId: policySigningKeyId(),
    });
    const [created] = await transaction.insert(policyBundles).values({
      ...scope,
      policyId,
      version,
      state: 'draft',
      lifecycleVersion: 1,
      canonicalJson: signed.payload as unknown as Record<string, unknown>,
      contentHash: signed.contentHash,
      signature: signed.signature,
      signatureAlgorithm: signed.signatureAlgorithm,
      signingKeyId: signed.signingKeyId,
      createdBy: actorId,
    }).returning();
    if (!created) throw new Error('Policy bundle insert returned no row');
    await transaction.insert(policyBundleTransitions).values(transitionRecord({
      scope, bundleId: created.id, fromState: null, toState: 'draft', action: 'compile',
      actorId, lifecycleVersion: 1,
    }));
    return created;
  });
}

/** Read-only compilation used to compare current draft content with signed snapshots. */
export async function compileCurrentPolicyDraft(scope: TenantScope, policyId: string, version: number) {
  const config = await getPolicyConfig(policyId, scope, { fresh: true });
  if (!config) {
    throw new PolicyBundleTransitionError('POLICY_NOT_AVAILABLE', 'Policy cannot be compiled');
  }
  const governance = await loadGovernedPolicyArtifacts(scope, policyId);
  const judgeDraft = await loadJudgeDraft(scope, policyId);
  return compilePolicyBundle(config, version, {
      semanticClassifier: parseSemanticClassifierBuildConfig(),
      judgeProfiles:judgeDraft.profilesV2,decisionPolicyVersion:judgeDraft.decisionPolicyVersion,
      semanticDecisionMode:judgeDraft.semanticDecisionMode,semanticCoverage:judgeDraft.semanticCoverage,
      resourceAdmission: parseGuardResourceAdmissionBuildConfig(),
      governance,
    });
}

function requireReason(action: BundleTransition, reason: string | undefined): void {
  if (['reject', 'rollback', 'withdraw', 'archive'].includes(action) && !reason?.trim()) {
    throw new PolicyBundleTransitionError('BUNDLE_REASON_REQUIRED', `Transition ${action} requires a reason`);
  }
}

function requireCanaryPercent(action: BundleTransition, canaryPercent: number | undefined): number {
  if (action !== 'canary') return 0;
  if (!Number.isInteger(canaryPercent) || canaryPercent! < 1 || canaryPercent! > 99) {
    throw new PolicyBundleTransitionError('CANARY_PERCENT_INVALID', 'Canary percent must be 1..99');
  }
  return canaryPercent!;
}

export async function transitionPolicyBundle(
  scope: TenantScope,
  bundleId: string,
  actorId: string,
  action: BundleTransition,
  options: BundleTransitionOptions,
): Promise<typeof policyBundles.$inferSelect> {
  requireReason(action, options.reason);
  const canaryPercent = requireCanaryPercent(action, options.canaryPercent);
  const updated = await db.transaction(async (transaction) => {
    const [bundle] = await transaction.select().from(policyBundles).where(and(
      eq(policyBundles.id, bundleId),
      scopePredicate(policyBundles, scope),
    )).limit(1).for('update');
    if (!bundle) throw new PolicyBundleTransitionError('BUNDLE_NOT_FOUND', 'Policy bundle was not found');
    if (bundle.lifecycleVersion !== options.expectedVersion) {
      throw new PolicyBundleTransitionError('BUNDLE_VERSION_CONFLICT', 'Reload the bundle before retrying');
    }
    if (action === 'approve' && bundle.createdBy === actorId) {
      throw new PolicyBundleTransitionError('BUNDLE_APPROVAL_REJECTED', 'A different principal must approve the bundle');
    }

    let evaluation: typeof evaluationRuns.$inferSelect | undefined;
    if (['record_test_pass','shadow','canary','activate'].includes(action)) {
      const evaluationRunId = action === 'record_test_pass' ? options.evaluationRunId : bundle.testEvidenceId;
      if (!evaluationRunId) {
        throw new PolicyBundleTransitionError('BUNDLE_EVALUATION_REQUIRED', 'A completed evaluation run is required');
      }
      [evaluation] = await transaction.select().from(evaluationRuns).where(and(
        eq(evaluationRuns.id, evaluationRunId),
        eq(evaluationRuns.bundleId, bundleId),
        scopePredicate(evaluationRuns, scope),
      )).limit(1).for('update');
      if (!evaluation) {
        throw new PolicyBundleTransitionError('BUNDLE_EVALUATION_NOT_FOUND', 'Evaluation evidence was not found for this bundle');
      }
      const violations = evaluationGateViolations(evaluation, resolvePolicyEvaluationGate());
      if (violations.length > 0) {
        throw new PolicyBundleTransitionError('BUNDLE_EVALUATION_GATE_FAILED', violations.join(', '));
      }
    }

    if(['record_test_pass','shadow','canary','activate'].includes(action))assertPublishableDetectionCapabilities(parseCompiledPolicyBundlePayload(bundle.canonicalJson));
    const currentState = bundle.state as PolicyBundleState;
    const nextState = nextPolicyBundleState(currentState, action);
    const now = new Date();
    const lifecycleVersion = bundle.lifecycleVersion + 1;
    const [binding] = await transaction.select().from(applicationPolicyBindings)
      .where(scopePredicate(applicationPolicyBindings, scope)).limit(1).for('update');

    if (action === 'shadow' || action === 'canary' || action === 'activate') {
      const values = {
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        activeBundleId: action === 'activate' ? bundleId : binding?.activeBundleId ?? null,
        previousBundleId: action === 'activate' ? binding?.activeBundleId ?? null : binding?.previousBundleId ?? null,
        shadowBundleId: action === 'shadow' ? bundleId : action === 'activate' ? null : binding?.shadowBundleId ?? null,
        canaryBundleId: action === 'canary' ? bundleId : action === 'activate' ? null : binding?.canaryBundleId ?? null,
        canaryPercent: action === 'canary' ? canaryPercent : action === 'activate' ? 0 : binding?.canaryPercent ?? 0,
        generation: (binding?.generation ?? 0) + 1,
        updatedBy: actorId,
        updatedAt: now,
      };
      await transaction.insert(applicationPolicyBindings).values(values).onConflictDoUpdate({
        target: [applicationPolicyBindings.tenantId, applicationPolicyBindings.applicationId],
        set: {
          activeBundleId: values.activeBundleId, previousBundleId: values.previousBundleId,
          shadowBundleId: values.shadowBundleId, canaryBundleId: values.canaryBundleId,
          canaryPercent: values.canaryPercent, generation: values.generation,
          updatedBy: values.updatedBy, updatedAt: values.updatedAt,
        },
      });
      if (action === 'activate' && binding?.activeBundleId && binding.activeBundleId !== bundleId) {
        const [replaced] = await transaction.select().from(policyBundles).where(and(
          eq(policyBundles.id, binding.activeBundleId), scopePredicate(policyBundles, scope),
        )).limit(1).for('update');
        if (replaced) {
          const replacedVersion = replaced.lifecycleVersion + 1;
          await transaction.update(policyBundles).set({ state: 'retired', lifecycleVersion: replacedVersion })
            .where(and(eq(policyBundles.id, replaced.id), eq(policyBundles.lifecycleVersion, replaced.lifecycleVersion)));
          await transaction.insert(policyBundleTransitions).values(transitionRecord({
            scope, bundleId: replaced.id, fromState: replaced.state, toState: 'retired',
            action: 'replaced', actorId, lifecycleVersion: replacedVersion,
            reason: `Replaced by bundle ${bundleId}`,
          }));
        }
      }
    }

    if (action === 'rollback') {
      if (!binding || binding.activeBundleId !== bundleId || !binding.previousBundleId) {
        throw new PolicyBundleTransitionError('BUNDLE_ROLLBACK_UNAVAILABLE', 'The requested bundle is not active or has no previous bundle');
      }
      const [previous] = await transaction.select().from(policyBundles).where(and(
        eq(policyBundles.id, binding.previousBundleId), scopePredicate(policyBundles, scope),
      )).limit(1).for('update');
      if (!previous) throw new PolicyBundleTransitionError('BUNDLE_NOT_FOUND', 'Previous bundle was not found');
      const previousVersion = previous.lifecycleVersion + 1;
      await transaction.update(applicationPolicyBindings).set({
        activeBundleId: previous.id, previousBundleId: bundleId, canaryBundleId: null,
        shadowBundleId: null, canaryPercent: 0, generation: binding.generation + 1,
        updatedBy: actorId, updatedAt: now,
      }).where(scopePredicate(applicationPolicyBindings, scope));
      await transaction.update(policyBundles).set({ state: 'active', activatedAt: now, lifecycleVersion: previousVersion })
        .where(and(eq(policyBundles.id, previous.id), eq(policyBundles.lifecycleVersion, previous.lifecycleVersion)));
      await transaction.insert(policyBundleTransitions).values(transitionRecord({
        scope, bundleId: previous.id, fromState: previous.state, toState: 'active',
        action: 'rollback_restore', actorId, lifecycleVersion: previousVersion,
        reason: options.reason, evidenceId: bundleId,
      }));
    }

    if (action === 'withdraw' && binding) {
      const wasActive = binding.activeBundleId === bundleId;
      await transaction.update(applicationPolicyBindings).set({
        activeBundleId: wasActive ? binding.previousBundleId : binding.activeBundleId,
        previousBundleId: wasActive ? null : binding.previousBundleId,
        shadowBundleId: binding.shadowBundleId === bundleId ? null : binding.shadowBundleId,
        canaryBundleId: binding.canaryBundleId === bundleId ? null : binding.canaryBundleId,
        canaryPercent: binding.canaryBundleId === bundleId ? 0 : binding.canaryPercent,
        generation: binding.generation + 1, updatedBy: actorId, updatedAt: now,
      }).where(scopePredicate(applicationPolicyBindings, scope));
      if (wasActive && binding.previousBundleId) {
        const [fallback] = await transaction.select().from(policyBundles).where(and(
          eq(policyBundles.id, binding.previousBundleId), scopePredicate(policyBundles, scope),
        )).limit(1).for('update');
        if (fallback) {
          const fallbackVersion = fallback.lifecycleVersion + 1;
          await transaction.update(policyBundles).set({ state: 'active', activatedAt: now, lifecycleVersion: fallbackVersion })
            .where(and(eq(policyBundles.id, fallback.id), eq(policyBundles.lifecycleVersion, fallback.lifecycleVersion)));
          await transaction.insert(policyBundleTransitions).values(transitionRecord({
            scope, bundleId: fallback.id, fromState: fallback.state, toState: 'active',
            action: 'withdraw_fallback', actorId, lifecycleVersion: fallbackVersion,
            reason: options.reason, evidenceId: bundleId,
          }));
        }
      }
    }

    const [result] = await transaction.update(policyBundles).set({
      state: nextState,
      lifecycleVersion,
      testedBy: action === 'record_test_pass' ? actorId : action === 'reject' ? null : bundle.testedBy,
      testedAt: action === 'record_test_pass' ? now : action === 'reject' ? null : bundle.testedAt,
      testEvidenceId: action === 'record_test_pass' ? evaluation!.id : action === 'reject' ? null : bundle.testEvidenceId,
      approvedBy: action === 'approve' ? actorId : action === 'reject' ? null : bundle.approvedBy,
      approvedAt: action === 'approve' ? now : action === 'reject' ? null : bundle.approvedAt,
      activatedAt: action === 'activate' ? now : bundle.activatedAt,
      archivedBy: action === 'archive' ? actorId : bundle.archivedBy,
      archivedAt: action === 'archive' ? now : bundle.archivedAt,
    }).where(and(
      eq(policyBundles.id, bundleId),
      eq(policyBundles.lifecycleVersion, options.expectedVersion),
      scopePredicate(policyBundles, scope),
      action === 'approve' ? ne(policyBundles.createdBy, actorId) : sql`true`,
    )).returning();
    if (!result) throw new PolicyBundleTransitionError('BUNDLE_VERSION_CONFLICT', 'Bundle changed during transition');
    await transaction.insert(policyBundleTransitions).values(transitionRecord({
      scope, bundleId, fromState: bundle.state, toState: nextState, action, actorId,
      lifecycleVersion, reason: options.reason, evidenceId: options.evaluationRunId,
      metadata: action === 'canary' ? { canaryPercent } : {},
    }));
    if (action === 'withdraw') await transaction.update(gatewayRuntimeSnapshots).set({ state: 'REVOKED' }).where(and(scopePredicate(gatewayRuntimeSnapshots, scope), eq(gatewayRuntimeSnapshots.bundleId, bundleId)));
    if (['shadow', 'canary', 'activate', 'rollback', 'withdraw'].includes(action)) await synchronizeGatewayPublication(transaction, scope, action, actorId, binding);
    return result;
  });
  clearRuntimePolicyBundleCache();
  return updated;
}
