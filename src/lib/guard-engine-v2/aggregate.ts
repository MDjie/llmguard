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
  const override = matches
    .map((item) => params.policy.actionOverrides?.[item.riskType])
    .find((action) => action === 'BLOCK' || action === 'REQUIRE_REVIEW');
  const action = mandatoryDeny || degradedBlock
    ? 'BLOCK'
    : override ??
      (maximumScore >= params.policy.blockThreshold
        ? 'BLOCK'
        : maximumScore >= params.policy.warnThreshold
          ? 'WARN'
          : 'ALLOW');
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
  return {
    contractVersion: '1.0',
    decisionId: `dec_${createHash('sha256').update(decisionSeed).digest('hex').slice(0, 32)}`,
    traceId: params.request.context.traceId,
    action,
    riskLevel,
    observations,
    policyPath: [params.policy.id, mandatoryDeny ? 'mandatory-deny' : 'score-threshold'],
    bundleId: params.policy.bundleId,
    latencyMs: Math.min(600_000, Math.max(0, Math.round(params.latencyMs))),
    degradationReasons: [...params.requiredDetectorFailures].sort(),
  };
}
