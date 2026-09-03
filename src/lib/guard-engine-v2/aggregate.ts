import { createHash } from 'node:crypto';
import type {
  GuardDecision,
  GuardEnginePolicy,
  GuardRequest,
  Observation,
  RiskLevel,
} from './types';

const riskOrder: Readonly<Record<RiskLevel, number>> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const actionOrder = {
  ALLOW: 0,
  WARN: 1,
  MASK: 2,
  REWRITE: 3,
  SAFE_RESPONSE: 4,
  REQUIRE_REVIEW: 5,
  BLOCK: 6,
} as const;

export function stableObservations(
  observations: readonly Observation[],
): readonly Observation[] {
  return [...observations].sort((left, right) =>
    left.detectorId.localeCompare(right.detectorId) ||
    left.riskType.localeCompare(right.riskType) ||
    right.score - left.score ||
    (left.evidence[0]?.start ?? 0) - (right.evidence[0]?.start ?? 0),
  );
}

export function aggregateGuardDecision(params: {
  readonly request: GuardRequest;
  readonly policy: GuardEnginePolicy;
  readonly observations: readonly Observation[];
  readonly requiredDetectorFailures: readonly string[];
  readonly degradationReasons?: readonly string[];
  readonly latencyMs: number;
}): GuardDecision {
  const observations = stableObservations(params.observations);
  const matches = observations.filter((item) => item.status === 'MATCH');
  const maximumScore = matches.reduce((maximum, item) => Math.max(maximum, item.score), 0);
  const maximumRisk = matches.reduce<RiskLevel>(
    (maximum, item) => riskOrder[item.severity] > riskOrder[maximum] ? item.severity : maximum,
    'NONE',
  );
  const mandatoryDeny = matches.some((item) => item.reasonCode === 'MANDATORY_DENY');
  const degradedBlock =
    params.policy.failClosedOnRequiredDetectorFailure &&
    params.requiredDetectorFailures.length > 0;
  const override = matches.reduce<GuardDecision['action'] | undefined>((selected, item) => {
    const candidate = params.policy.actionOverrides?.[item.riskType];
    const threshold = params.policy.actionOverrideThresholds?.[item.riskType]
      ?? params.policy.warnThreshold;
    if (!candidate || item.score < threshold) return selected;
    return !selected || actionOrder[candidate] > actionOrder[selected] ? candidate : selected;
  }, undefined);
  const thresholdBlock = maximumScore >= params.policy.blockThreshold;
  const action = mandatoryDeny || degradedBlock || thresholdBlock
    ? 'BLOCK'
    : override ?? (maximumScore >= params.policy.warnThreshold ? 'WARN' : 'ALLOW');
  const riskLevel = degradedBlock && riskOrder[maximumRisk] < riskOrder.HIGH
    ? 'HIGH'
    : maximumRisk;
  const decisionSeed = JSON.stringify({
    requestId: params.request.context.requestId,
    traceId: params.request.context.traceId,
    bundleId: params.policy.bundleId,
    action,
    observations,
  });
  const modelVersions = [...new Set(
    observations.flatMap((observation) =>
      observation.modelVersion === undefined ? [] : [observation.modelVersion],
    ),
  )].sort();
  const degradationReasons = [
    ...new Set(params.degradationReasons ?? params.requiredDetectorFailures),
  ].sort();
  const failMode = degradationReasons.length === 0
    ? 'NORMAL'
    : degradedBlock
      ? 'FAIL_CLOSED'
      : 'DEGRADED';
  const evidenceComplete = matches.every((observation) =>
    observation.evidence.length > 0 &&
    observation.evidence.every((evidence) =>
      evidence.artifactId !== undefined || (evidence.sourceEnvelopeIds?.length ?? 0) > 0,
    ),
  );
  return {
    contractVersion: '1.0',
    decisionId: `dec_${createHash('sha256').update(decisionSeed).digest('hex').slice(0, 32)}`,
    traceId: params.request.context.traceId,
    action,
    riskLevel,
    observations,
    policyPath: [
      params.policy.id,
      mandatoryDeny
        ? 'mandatory-deny'
        : degradedBlock
          ? 'required-detector-failure'
          : thresholdBlock
            ? 'block-threshold'
            : override
              ? 'action-override'
              : 'score-threshold',
    ],
    bundleId: params.policy.bundleId,
    latencyMs: Math.min(600_000, Math.max(0, Math.round(params.latencyMs))),
    degradationReasons,
    ...(modelVersions.length > 0 ? { modelVersions } : {}),
    failMode,
    evidenceComplete,
  };
}
