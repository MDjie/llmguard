import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { GuardRequest } from '@guardllm/contracts';
import { verifyScopedAuditChain } from '@/lib/audit';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { observePolicyBundleGeneration } from '@/lib/observability/metrics';
import { releaseHealthAction, type ReleaseHealthSignals } from '@/lib/release/automatic-rollback';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applicationPolicyBindings, policyBundles } from '@/storage/database/shared/schema';
import { recordPolicyIntegrityFailure } from './integrity-events';
import { clearRuntimePolicyBundleCache, loadRuntimePolicyBundle } from './runtime';
import { PolicyBundleTransitionError } from './lifecycle';
import { transitionPolicyBundle } from './service';

export interface ReleaseHealthReconciliationInput extends ReleaseHealthSignals {
  readonly bundleId: string;
  readonly expectedGeneration: number;
  readonly promoteWhenHealthy: boolean;
}

async function verifyReleaseTransition(scope: TenantScope) {
  clearRuntimePolicyBundleCache();
  const requestId = randomUUID();
  const bundle = await loadRuntimePolicyBundle(scope, undefined, requestId);
  const request: GuardRequest = {
    contractVersion: '1.0',
    context: {
      traceId: randomUUID(),
      requestId,
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      direction: 'INPUT',
      sourceType: 'SYSTEM',
      locale: 'zh-CN',
      absoluteDeadlineEpochMs: Date.now() + 15_000,
      policyBundleId: bundle.id,
      stage: 'INPUT_PRE',
    },
    content: { text: '这是策略发布后的只读健康检查请求。' },
  };
  const decision = await createEngineForPolicyBundle(bundle).evaluate(request);
  if (!['ALLOW', 'WARN'].includes(decision.action)) {
    throw new PolicyBundleTransitionError(
      'BUNDLE_POST_TRANSITION_SMOKE_FAILED',
      'The restored bundle did not pass the core smoke request.',
    );
  }
  let audit;
  try {
    audit = await verifyScopedAuditChain(scope);
  } catch (error) {
    await recordPolicyIntegrityFailure({
      failure: 'AUDIT_CHAIN_BREAK',
      scope,
      bundleId: bundle.id,
      detailCode: 'POST_TRANSITION_AUDIT_CHAIN_INVALID',
      generation: bundle.generation,
    }).catch(() => undefined);
    throw new PolicyBundleTransitionError(
      'BUNDLE_POST_TRANSITION_AUDIT_FAILED',
      'The audit chain failed verification after the release transition.',
    );
  }
  observePolicyBundleGeneration({
    generation: bundle.generation,
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
  });
  return {
    bundleId: bundle.id,
    generation: bundle.generation,
    smokeAction: decision.action,
    smokeDecisionId: decision.decisionId,
    auditEventsChecked: audit.checked,
    auditHeadHash: audit.headHash,
  };
}

export async function reconcilePolicyReleaseHealth(
  scope: TenantScope,
  actorId: string,
  input: ReleaseHealthReconciliationInput,
) {
  const [[binding], [bundle]] = await Promise.all([
    db.select().from(applicationPolicyBindings)
      .where(scopePredicate(applicationPolicyBindings, scope)).limit(1),
    db.select().from(policyBundles).where(and(
      eq(policyBundles.id, input.bundleId),
      scopePredicate(policyBundles, scope),
    )).limit(1),
  ]);
  if (!binding || !bundle) {
    throw new PolicyBundleTransitionError('BUNDLE_NOT_FOUND', 'Release binding or bundle was not found.');
  }
  if (binding.generation !== input.expectedGeneration) {
    throw new PolicyBundleTransitionError('BUNDLE_GENERATION_CONFLICT', 'Release generation changed; reload before retrying.');
  }
  const health = releaseHealthAction(input);
  if (health.action === 'HOLD') {
    return { outcome: 'HELD' as const, health, verification: null };
  }
  if (health.action === 'CONTINUE' && !input.promoteWhenHealthy) {
    return { outcome: 'CONTINUING' as const, health, verification: null };
  }
  if (health.action === 'CONTINUE') {
    if (binding.canaryBundleId !== bundle.id || bundle.state !== 'canary') {
      throw new PolicyBundleTransitionError('BUNDLE_PROMOTION_UNAVAILABLE', 'Only the current canary bundle can be promoted.');
    }
    await transitionPolicyBundle(scope, bundle.id, actorId, 'activate', {
      expectedVersion: bundle.lifecycleVersion,
      reason: 'Automatic promotion after healthy canary thresholds.',
    });
    return {
      outcome: 'PROMOTED' as const,
      health,
      verification: await verifyReleaseTransition(scope),
    };
  }

  const reason = 'Automatic release stop: ' + health.reasonCodes.join(', ');
  if (binding.canaryBundleId === bundle.id && bundle.state === 'canary') {
    await transitionPolicyBundle(scope, bundle.id, actorId, 'withdraw', {
      expectedVersion: bundle.lifecycleVersion,
      reason,
    });
  } else if (binding.activeBundleId === bundle.id && bundle.state === 'active') {
    await transitionPolicyBundle(scope, bundle.id, actorId, 'rollback', {
      expectedVersion: bundle.lifecycleVersion,
      reason,
    });
  } else {
    throw new PolicyBundleTransitionError('BUNDLE_ROLLBACK_UNAVAILABLE', 'The unhealthy bundle is neither current canary nor active.');
  }
  return {
    outcome: 'ROLLED_BACK' as const,
    health,
    verification: await verifyReleaseTransition(scope),
  };
}
