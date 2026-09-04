import { createHmac } from 'node:crypto';
import {
  attachContextSources,
  resolveContextEnvelopes,
  validateActionIntent,
} from '@/lib/context-trust';
import { aggregateGuardDecision } from './aggregate';
import { executeDetectorDag, resolveAndValidateDetectorDag } from './dag';
import { buildNormalizedViews } from './normalization';
import { observeGuardDecision, observeSafetyAlert } from '@/lib/observability/metrics';
import type {
  GuardDetector,
  GuardEngine,
  GuardEngineDependencies,
  GuardEnginePolicy,
  GuardRequest,
} from './types';

export function createGuardEngine(
  policy: GuardEnginePolicy,
  detectors: readonly GuardDetector[],
  dependencies: GuardEngineDependencies,
): GuardEngine {
  const now = dependencies.now ?? Date.now;
  const hmacKey = dependencies.hmacKey;
  if (Buffer.byteLength(hmacKey) < 32) {
    throw new Error('GuardEngine evidence HMAC key must contain at least 32 bytes');
  }
  const detectorIds = new Set<string>();
  for (const detector of detectors) {
    if (detectorIds.has(detector.id)) throw new Error(`Duplicate detector id: ${detector.id}`);
    detectorIds.add(detector.id);
  }
  const detectorDag = resolveAndValidateDetectorDag(policy.detectorDag, detectors);

  return {
    async evaluate(request: GuardRequest) {
      const startedAt = now();
      if ((request.content.text?.length ?? 0) > 1_048_576) {
        throw new Error('GRD_TEXT_CAPACITY_EXCEEDED');
      }
      const remaining = request.context.absoluteDeadlineEpochMs - startedAt;
      if (remaining <= 0) throw new Error('GRD_DEADLINE_EXCEEDED');
      if (request.context.policyBundleId !== policy.bundleId) {
        throw new Error('GRD_POLICY_BUNDLE_MISMATCH');
      }
      const envelopes = resolveContextEnvelopes(request, startedAt);
      validateActionIntent(request, envelopes, startedAt);
      const views = buildNormalizedViews(
        request.content.text ?? '',
        dependencies.normalizationBudget,
      );
      const deadlineSignal = AbortSignal.timeout(remaining);
      const evidenceHmac = (content: string) =>
        createHmac('sha256', hmacKey).update(content, 'utf8').digest('hex');
      const execution = await executeDetectorDag({
        dag: detectorDag,
        detectors,
        context: {
          request,
          envelopes,
          views,
          evidenceHmac,
          protectedContextFingerprints: dependencies.protectedContextFingerprints,
        },
        deadlineSignal,
        absoluteDeadlineEpochMs: request.context.absoluteDeadlineEpochMs,
        blockThreshold: policy.blockThreshold,
        now,
      });
      const observations = attachContextSources(
        execution.observations,
        envelopes,
      );
      const decision = aggregateGuardDecision({
        request,
        policy,
        observations,
        requiredDetectorFailures: execution.failClosedReasons,
        degradationReasons: execution.degradationReasons,
        latencyMs: now() - startedAt,
      });
      const matchedRisk = decision.observations.find((item) => item.status === 'MATCH')?.riskType;
      const modalities = [...new Set([
        ...(request.content.text === undefined ? [] : ['TEXT']),
        ...(request.content.artifacts ?? []).map((artifact) => artifact.kind),
      ])].sort().join('|') || 'OTHER';
      observeGuardDecision({
        direction: request.context.direction,
        action: decision.action,
        latencyMs: decision.latencyMs,
        detectorFailures: execution.degradationReasons.length,
        riskCategory: matchedRisk,
        tenantId: request.context.tenantId,
        applicationId: request.context.applicationId,
        locale: request.context.locale,
        modality: modalities,
        policyVersion: policy.policyVersion,
        degraded: decision.degraded,
      });
      if (
        decision.observations.some((item) => item.status === 'MATCH' && item.reasonCode === 'MANDATORY_DENY') &&
        decision.action !== 'BLOCK'
      ) {
        observeSafetyAlert('MANDATORY_DENY_BYPASS');
      }
      return decision;
    },
  };
}
