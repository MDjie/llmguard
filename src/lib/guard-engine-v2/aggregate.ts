import { createHash } from 'node:crypto';
import { selectJudgeProfile } from '@/lib/judge/profile';
import { coverageGaps } from './semantic-coverage';
import { combineActionConstraints } from './action-constraints';
import { isConfirmedObservation } from './observation-role';
import { createObservationPolicy } from './observation-policy';
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
  readonly degradationReasons?: readonly string[];
  readonly latencyMs: number;
}): GuardDecision {
  const observations = stableObservations(params.observations);
  const v2 = params.policy.decisionPolicyVersion === 2;
  const selectedJudge = selectJudgeProfile(params.policy.judgeProfiles ?? [], params.request.context);
  // 语义能力（judge 或 classifier）被声明时才要求覆盖到位：
  // 两者皆未配置的 v2 策略是纯词法模式，不应因“没有 ENFORCE judge”全场
  // fail-closed（那会把误配变成拒绝服务）；配置了语义组件的旧 bundle 行为不变
  const semanticCapabilityConfigured =
    (params.policy.judgeProfiles ?? []).some((profile) => profile.enabled) ||
    params.policy.semanticClassifier !== undefined;
  const coverageMode=params.policy.semanticDecisionMode==='coverage-v1';
  const missingRisks=coverageGaps(params.policy,params.request,observations);
  const judgeMissing = coverageMode ? missingRisks.length>0 : (v2 && semanticCapabilityConfigured && selectedJudge?.mode !== 'ENFORCE') || (selectedJudge?.mode === 'ENFORCE' && selectedJudge.riskIds.some(id => !observations.some(o => o.detectorId === 'configurable-judge' && o.riskType === id && o.semanticCoverage === 'COMPLETE' && (o.decisionRole === 'CLEARED' || o.decisionRole === 'CONFIRMED_RISK'))));
  const candidates = observations.filter(o => o.decisionRole === 'CANDIDATE');
  const unresolvedCandidates = candidates.some(c => !observations.some(o => o.riskType === c.riskType && o.semanticCoverage === 'COMPLETE' && (o.decisionRole === 'CLEARED' || o.decisionRole === 'CONFIRMED_RISK')));
  const unresolved = v2 && unresolvedCandidates;
  const matches = observations.filter(isConfirmedObservation);
  const { thresholds, override: applicableOverride, thresholdBlock: isThresholdBlock } = createObservationPolicy(params.policy, params.request.context.direction);
  const maximumRisk = matches.reduce<RiskLevel>(
    (maximum, item) => riskOrder[item.severity] > riskOrder[maximum] ? item.severity : maximum,
    'NONE',
  );
  const mandatoryDeny = matches.some((item) => item.reasonCode === 'MANDATORY_DENY' || item.decisionRole === 'HARD_DENY');
  const degradedBlock =
    params.policy.failClosedOnRequiredDetectorFailure &&
    (params.requiredDetectorFailures.length > 0 || Boolean(judgeMissing));
  const overrideActions = matches.flatMap((item) => {
    const candidate = applicableOverride(item);
    return candidate ? [candidate] : [];
  });
  const override = overrideActions.length > 0 ? combineActionConstraints(overrideActions).action : undefined;
  // Input thresholds remain terminal for compatibility. Output policies are independent:
  // an explicit MASK/REWRITE/REVIEW/SAFE_RESPONSE action may process a high-confidence
  // match, while unclassified high-confidence findings and explicit BLOCK overrides
  // still fail closed.
  const thresholdBlock = matches.some(isThresholdBlock);
  const action = mandatoryDeny || degradedBlock || thresholdBlock || override === 'BLOCK'
    ? 'BLOCK'
    : unresolved || judgeMissing ? 'REQUIRE_REVIEW' : override ?? (matches.some(item => item.score >= thresholds(item.riskType).warn) || unresolvedCandidates ? 'WARN' : 'ALLOW');
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
    ...(judgeMissing ? [coverageMode?'SEMANTIC_COVERAGE_INCOMPLETE':'JUDGE_COVERAGE_INCOMPLETE'] : []),
    ...new Set(params.degradationReasons ?? params.requiredDetectorFailures),
  ].sort();
  const failMode = degradationReasons.length === 0
    ? 'NORMAL'
    : degradedBlock
      ? 'FAIL_CLOSED'
      : 'DEGRADED';
  const reasonCodes = [...new Set([
    ...(unresolvedCandidates ? [v2 ? 'LEXICAL_CANDIDATE_REQUIRES_REVIEW' : 'LEXICAL_CANDIDATE_UNRESOLVED'] : []),
    ...matches.flatMap((observation) => observation.reasonCode ? [observation.reasonCode] : []),
    ...params.requiredDetectorFailures,
    ...degradationReasons,
  ])].sort();
  const latencyMs = Math.min(600_000, Math.max(0, Math.round(params.latencyMs)));
  const evidenceComplete = degradationReasons.length === 0 && !judgeMissing && !unresolvedCandidates && matches.every((observation) =>
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
    latencyMs,
    latencyBreakdown: { totalMs: latencyMs },
    degraded: degradationReasons.length > 0,
    reasonCodes,
    degradationReasons,
    ...(modelVersions.length > 0 ? { modelVersions } : {}),
    failMode,
    evidenceComplete,
  };
}
