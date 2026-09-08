import { createHash, randomUUID } from 'node:crypto';
import type {
  GuardAction,
  GuardDecision,
  InstructionCapability,
  SourceType,
  TrustLevel,
} from '@guardllm/contracts';
import { createEngineForPolicyBundle, evaluateWithSessionContext } from '@/lib/guard-engine-v2';
import {
  isPolicyBundleRuntimeError,
  loadLatestVerifiedPolicyBundleForPolicy,
  type CompiledPolicyBundle,
} from '@/lib/policy-bundle';
import type { TenantScope } from '@/lib/tenancy';
import { DetectionPolicyError } from './errors';
import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
import type { DetectionFinding, DetectionResult } from './types';

export interface GuardEngineV2DetectionOptions {
  readonly taskPurpose?: string;
  readonly requestId?: string;
  readonly locale?: string;
  readonly industry?: string;
  readonly memoryMode?: 'read_only' | 'read_write';
  readonly allowPreRelease?: boolean;
  readonly sessionId?: string;
  readonly subjectId?: string;
  readonly authContextId?: string;
  readonly sourceType?: SourceType;
  readonly sourceId?: string;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

interface EvidenceSpan {
  readonly start: number;
  readonly end: number;
}

const actionLabels: Readonly<Record<DetectionResult['action'], string>> = {
  allow: '已放行',
  warn: '已警告',
  block: '已拦截',
  mask: '已脱敏',
  rewrite: '已改写',
};

function legacyAction(action: GuardAction): DetectionResult['action'] {
  switch (action) {
    case 'WARN': return 'warn';
    case 'MASK': return 'mask';
    case 'REWRITE': return 'rewrite';
    case 'BLOCK':
    case 'SAFE_RESPONSE':
    case 'REQUIRE_REVIEW':
      return 'block';
    default:
      return 'allow';
  }
}

function sourceTrust(sourceType: SourceType): {
  readonly trustLevel: TrustLevel;
  readonly instructionCapability: InstructionCapability;
} {
  if (sourceType === 'SYSTEM') {
    return { trustLevel: 'TRUSTED', instructionCapability: 'ALLOWED' };
  }
  if (sourceType === 'USER') {
    return { trustLevel: 'CONTROLLED', instructionCapability: 'ALLOWED' };
  }
  if (sourceType === 'AGENT') {
    return { trustLevel: 'CONTROLLED', instructionCapability: 'DATA_ONLY' };
  }
  return { trustLevel: 'UNTRUSTED', instructionCapability: 'FORBIDDEN' };
}

function evidenceSpans(decision: GuardDecision, textLength: number): EvidenceSpan[] {
  const spans = decision.observations
    .filter(isConfirmedObservation)
    .flatMap((observation) => observation.evidence)
    .flatMap((evidence) => {
      if (evidence.start === undefined || evidence.end === undefined) return [];
      const start = Math.max(0, Math.min(textLength, evidence.start));
      const end = Math.max(start, Math.min(textLength, evidence.end));
      return end > start ? [{ start, end }] : [];
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: EvidenceSpan[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, span.end) };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function transformEvidence(
  text: string,
  spans: readonly EvidenceSpan[],
  replacement: (segment: string) => string,
): string {
  let transformed = text;
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    transformed = transformed.slice(0, span.start)
      + replacement(transformed.slice(span.start, span.end))
      + transformed.slice(span.end);
  }
  return transformed;
}

function maskSegment(segment: string): string {
  if (segment.length <= 2) return '*'.repeat(segment.length);
  return segment[0] + '*'.repeat(segment.length - 2) + segment.at(-1);
}

const LEGACY_DIMENSION_CODES: Readonly<Record<string, string>> = {
  'business.secret': 'business_sensitive',
  'credential.secret': 'credential_secret_leak',
};

export function legacyDimensionCode(riskType: string): string {
  return LEGACY_DIMENSION_CODES[riskType] ?? riskType;
}

function findingName(riskType: string, bundle: CompiledPolicyBundle): string {
  return bundle.dimensions.find((dimension) => dimension.code === riskType)?.name ?? riskType;
}

function observationFinding(
  observation: GuardDecision['observations'][number],
  action: DetectionResult['action'],
  bundle: CompiledPolicyBundle,
): DetectionFinding {
  const firstRange = observation.evidence.find(
    (evidence) => evidence.start !== undefined && evidence.end !== undefined,
  );
  const ruleId = observation.reasonCode?.startsWith('RULE_')
    ? observation.reasonCode.slice('RULE_'.length)
    : undefined;
  const rule = ruleId ? bundle.rules.find((candidate) => candidate.id === ruleId) : undefined;
  const dimensionCode = legacyDimensionCode(observation.riskType);
  return {
    dimension: dimensionCode,
    dimensionCode,
    dimensionName: findingName(dimensionCode, bundle),
    dimensionId: bundle.dimensions.find(
      (dimension) => dimension.code === dimensionCode,
    )?.id,
    score: Math.round(observation.score * 100),
    scoreMeaning: observation.scoreMeaning ?? 'UNCALIBRATED',
    ...(observation.scoreMeaning === 'PROBABILITY' ? {confidence: observation.score} : {}),
    severity: observation.severity === 'CRITICAL'
      ? 'critical'
      : observation.severity === 'HIGH'
        ? 'high'
        : observation.severity === 'MEDIUM'
          ? 'medium'
          : 'low',
    action,
    matchedRules: [observation.reasonCode ?? observation.detectorId],
    evidence: observation.evidence.flatMap(
      (evidence) => evidence.maskedPreview === undefined ? [] : [evidence.maskedPreview],
    ),
    maskedEvidence: observation.evidence.flatMap(
      (evidence) => evidence.maskedPreview === undefined ? [] : [evidence.maskedPreview],
    ),
    reason: observation.reasonCode ?? 'GUARD_ENGINE_V2_MATCH',
    suggestion: '',
    ruleId,
    ruleName: rule?.id,
    ruleType: rule?.matchType === 'regex' ? 'regex' : rule ? 'keyword' : undefined,
    startOffset: firstRange?.start,
    endOffset: firstRange?.end,
  };
}

export function adaptGuardDecisionToDetectionResult(
  text: string,
  decision: GuardDecision,
  bundle: CompiledPolicyBundle,
): DetectionResult {
  const action = legacyAction(decision.action);
  const matched = decision.observations.filter(isConfirmedObservation);
  const findings = matched.map((observation) => observationFinding(observation, action, bundle));
  const maximumScore = matched.reduce(
    (maximum, observation) => Math.max(maximum, observation.score),
    0,
  );
  const spans = evidenceSpans(decision, text.length);
  const result: DetectionResult = {
    overallScore: Math.round(maximumScore * 100),
    confidence: Math.max(0, ...matched.filter(item => item.scoreMeaning === 'PROBABILITY').map(item => item.score)),
    confidenceMeaning: matched.length > 0 && matched.every(item => item.scoreMeaning === 'PROBABILITY') ? 'PROBABILITY' : 'UNCALIBRATED',
    rawAction: decision.action,
    operationalOutcome: decision.degradationReasons.length ? 'INCOMPLETE' : decision.action === 'REQUIRE_REVIEW' ? 'REQUIRES_REVIEW' : 'COMPLETE',
    action,
    findings,
    summary: findings.length === 0
      ? (decision.action === 'ALLOW' ? '未检测到已确认安全风险' : '检测未完成或需要复核；最终动作: ' + actionLabels[action])
      : '风险维度: ' + [...new Set(findings.map((finding) => finding.dimensionName))].join('、')
        + '；最终动作: ' + actionLabels[action],
    latencyMs: decision.latencyMs,
    policyVersion: bundle.policyVersion,
    degradationReasons: decision.degradationReasons.length > 0
      ? [...decision.degradationReasons]
      : undefined,
    decisionTrace: {
      ruleScore: Math.round(maximumScore * 100),
      ruleAction: action === 'mask' || action === 'rewrite' ? 'warn' : action,
      decisionMode: 'guard-engine-v2',
      finalScore: Math.round(maximumScore * 100),
      finalAction: action === 'mask' || action === 'rewrite' ? 'warn' : action,
      reasoning: decision.policyPath.join(' > '),
    },
  };
  if (action === 'mask') {
    result.maskedText = transformEvidence(text, spans, maskSegment);
  } else if (action === 'rewrite') {
    result.rewrittenText = transformEvidence(text, spans, () => '[已安全化处理]');
  }
  return result;
}

export async function detectWithGuardEngineV2(
  text: string,
  policyId: string,
  scope: TenantScope,
  direction: 'input' | 'output' = 'input',
  options: GuardEngineV2DetectionOptions = {},
): Promise<DetectionResult> {
  options.signal?.throwIfAborted();
  let bundle;
  try {
    bundle = await loadLatestVerifiedPolicyBundleForPolicy(scope, policyId, {
      allowPreRelease: options.allowPreRelease,
      routingKey: options.sessionId ?? options.subjectId ?? policyId,
    });
  } catch (error) {
    throw new DetectionPolicyError(
      isPolicyBundleRuntimeError(error) ? error.code : 'POLICY_LOAD_FAILED',
      'No signed executable policy bundle is available',
      { cause: error },
    );
  }
  const sourceType = options.sourceType ?? (direction === 'output' ? 'AGENT' : 'USER');
  const trust = sourceTrust(sourceType);
  const now = Date.now();
  const requestId = options.requestId ?? 'compat-' + randomUUID();
  if (requestId.length < 8 || requestId.length > 128) throw new Error('GUARD_REQUEST_ID_INVALID');
  const deadlineMs = Math.min(60_000, Math.max(100, options.deadlineMs ?? 30_000));
  const engine = createEngineForPolicyBundle(bundle);
  const decision = await evaluateWithSessionContext(engine, {
    contractVersion: '1.0',
    context: {
      traceId: 'compat-trace-' + createHash('sha256').update(requestId).digest('hex').slice(0,32),
      requestId,
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      ...(options.taskPurpose ? {taskPurpose: options.taskPurpose.slice(0,4096)} : {}),
      ...(options.locale ? {locale:options.locale} : {}),
      ...(options.industry ? {industry:options.industry} : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.subjectId ? { subjectId: options.subjectId } : {}),
      ...(options.authContextId ? { authContextId: options.authContextId } : {}),
      direction: direction === 'output' ? 'OUTPUT_COMPLETE' : 'INPUT',
      absoluteDeadlineEpochMs: now + deadlineMs,
      policyBundleId: bundle.id,
      stage: direction === 'output' ? 'OUTPUT_POST' : 'INPUT_PRE',
    },
    content: {
      text,
      envelopes: [{
        envelopeId: 'env-' + createHash('sha256').update(JSON.stringify([scope.tenantId,scope.applicationId,options.sessionId ?? '',requestId,direction,options.sourceId ?? requestId])).digest('hex').slice(0,32),
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        sourceType,
        sourceId: options.sourceId ?? requestId,
        trustLevel: trust.trustLevel,
        instructionCapability: trust.instructionCapability,
        sensitivityLabels: [],
        contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        parentEnvelopeIds: [],
        policyVersion: String(bundle.payload.policyVersion),
        eventSeq: 0,
        contentStart: 0,
        contentEnd: text.length,
      }],
    },
  }, scope, {readOnly:options.allowPreRelease || options.memoryMode === 'read_only'});
  options.signal?.throwIfAborted();
  return adaptGuardDecisionToDetectionResult(text, decision, bundle.payload);
}
