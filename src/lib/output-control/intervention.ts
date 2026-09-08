import { collectTransformEntities } from '@/lib/dlp/entity-contract';
import { createHash } from 'node:crypto';
import { deriveContextEnvelope, resolveContextEnvelopes, validateActionIntent } from '@/lib/context-trust';
import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
import type {
  DecisionTransform,
  GuardAction,
  GuardDecision,
  GuardRequest,
  Observation,
} from '@guardllm/contracts';
import {
  transformDlpText,
  type DlpTransformRange,
} from '@/lib/dlp';
import { observeOutputControl } from '@/lib/observability/metrics';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle/runtime';
import {
  OUTPUT_ACTION_OVERRIDES,
  isOutputDirection,
  isOutputRedline,
  resolveOutputPolicyContext,
} from './policy';
import type {
  OutputControlFailureInput,
  OutputControlSecurityEventSink,
} from './security-event';
import {
  PLATFORM_FIXED_SAFE_RESPONSE,
  PLATFORM_REVIEW_RESPONSE,
  builtInOutputResponseTemplates,
  legalDisclaimer,
  renderResponseTemplate,
  type RuntimeResponseTemplate,
} from './templates';

export interface OutputInterventionOptions {
  readonly evidenceHmacKey: string | Buffer;
  readonly tokenizationHmacKey?: string | Buffer;
  readonly evaluateRecheck: (request: GuardRequest) => Promise<GuardDecision>;
  readonly securityEventSink?: OutputControlSecurityEventSink;
  readonly now?: () => number;
  readonly deferRecheck?: boolean;
}

const TRANSFORM_RECHECK_ACTIONS = new Set<GuardAction>(['MASK', 'REWRITE', 'SAFE_RESPONSE']);
function matched(decision: GuardDecision): readonly Observation[] {
  return decision.observations.filter(isConfirmedObservation);
}

function strongestRiskType(decision: GuardDecision): string | undefined {
  const matchingAction = matched(decision).find(
    (observation) => OUTPUT_ACTION_OVERRIDES[observation.riskType] === decision.action,
  );
  return matchingAction?.riskType ?? matched(decision)[0]?.riskType;
}

const INSURANCE_REWRITES: readonly [RegExp, string][] = [
  [/(?:保本保收益|保证(?:收益|年化|回报)|稳赚不赔|零风险高收益)/giu,
    '收益存在不确定性，实际表现不作保证'],
  [/(?:guaranteed\s+(?:return|yield)|risk[- ]free\s+(?:profit|return))/giu,
    'returns are uncertain and are not guaranteed'],
  [/(?:任何情况都赔|肯定理赔|百分之百赔付|100%\s*(?:理赔|赔付))/giu,
    '是否赔付需依据保险责任、责任免除及实际审核结果确定'],
  [/(?:claim\s+is\s+guaranteed|always\s+(?:covered|paid))/giu,
    'claim eligibility depends on the policy terms, exclusions, and review outcome'],
  [/(?:免责条款不重要|条款无需看|不用看保险责任|忽略免责)/giu,
    '请完整阅读保险责任和责任免除条款'],
  [/(?:exclusions? (?:do not matter|can be ignored)|ignore (?:the )?exclusions?)/giu,
    'please review all coverage terms and exclusions'],
  [/(?:等待期(?:可以忽略|没有影响|无需关注)|不用管等待期)/giu,
    '等待期会影响保障生效和理赔条件，请以合同约定为准'],
  [/(?:无需健康告知|隐瞒病史.{0,20}(?:也能|可以).{0,12}(?:投保|理赔)|不用告知.{0,20}(?:疾病|病史))/giu,
    '投保时应如实完成健康告知，承保及理赔以合同和审核结果为准'],
  [/(?:hide.{0,20}(?:medical history|pre-existing condition))/giu,
    'health information must be disclosed truthfully and reviewed under the policy terms'],
  [/(?:(?:监管部门|金融监管机构|银保监会).{0,28}(?:唯一指定|官方推荐|保证认可))/giu,
    '不得声称未经核实的监管指定、推荐或保证'],
  [/(?:(?:我|本顾问|本代理人).{0,16}(?:保证|承诺).{0,28}(?:收益|一定理赔|没有风险))/giu,
    '任何个人均无权作出超出正式合同的收益或理赔承诺'],
];

function rewriteInsuranceOutput(text: string, disclaimerVersion: string): string {
  let rewritten = text;
  for (const [pattern, replacement] of INSURANCE_REWRITES) rewritten = rewritten.replace(pattern, replacement);
  const disclaimer = legalDisclaimer(disclaimerVersion);
  if (disclaimer && !rewritten.includes(disclaimer)) rewritten = `${rewritten}\n\n${disclaimer}`;
  return rewritten === text ? `${PLATFORM_FIXED_SAFE_RESPONSE}\n\n${disclaimer}`.trim() : rewritten;
}

function boundedRecheckRequestId(requestId: string, outputHash: string): string {
  const suffix = `-recheck-${outputHash.slice(0, 12)}`;
  return `${requestId.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`;
}

function templates(bundle: RuntimePolicyBundle): readonly RuntimeResponseTemplate[] {
  return [
    ...((bundle.payload.responseTemplates ?? []) as readonly RuntimeResponseTemplate[]),
    ...builtInOutputResponseTemplates(),
  ];
}

function safeTemplateVariables(request: GuardRequest, riskType: string): Readonly<Record<string, string>> {
  const context = resolveOutputPolicyContext(request);
  return {
    requestId: request.context.requestId,
    traceId: request.context.traceId,
    riskType,
    locale: context.locale,
    industry: context.industry,
    jurisdiction: context.jurisdiction,
    businessLine: context.businessLine,
    legalDisclaimer: legalDisclaimer(context.legalDisclaimerVersion),
  };
}

function transformedRanges(ranges: readonly DlpTransformRange[]): DecisionTransform['ranges'] {
  return ranges.map((range) => ({
    entityType: range.entityType,
    operation: range.operation,
    start: range.start,
    end: range.end,
    outputStart: range.outputStart,
    outputEnd: range.outputEnd,
    maskedPreview: range.maskedPreview,
    contentHmac: range.contentHmac,
  }));
}

async function emitFailure(
  sink: OutputControlSecurityEventSink | undefined,
  input: OutputControlFailureInput,
): Promise<boolean> {
  if (!sink) return true;
  try {
    await sink(input);
    return true;
  } catch {
    return false;
  }
}

function riskScore(decision: GuardDecision): number {
  return matched(decision).reduce((maximum, observation) => Math.max(maximum, observation.score), 0);
}

export async function applyOutputIntervention(
  request: GuardRequest,
  decision: GuardDecision,
  bundle: RuntimePolicyBundle,
  options: OutputInterventionOptions,
): Promise<GuardDecision> {
  if (!isOutputDirection(request.context.direction)) return decision;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const context = resolveOutputPolicyContext(request);
  const riskType = strongestRiskType(decision) ?? 'output.none';
  const originalText = request.content.text ?? '';
  let action = decision.action;
  let transformedText: string | undefined;
  let ranges: DecisionTransform['ranges'] = [];
  let transformType: DecisionTransform['type'] | undefined;
  let templateId: string | undefined;
  let templateVersion: number | undefined;
  let recheckDecisionId: string | undefined;
  let recheckStatus: 'completed' | 'failed' | 'not_required' = 'not_required';
  let templateFallback = false;
  const addedReasonCodes: string[] = [];
  const recheckObservations:Observation[]=[];
  const degradationReasons = [...decision.degradationReasons];

  if (action === 'MASK') {
    try {
    const entities = collectTransformEntities(decision.observations,originalText.length);
    if (entities.length === 0) {
      action = 'BLOCK';
      transformedText = PLATFORM_FIXED_SAFE_RESPONSE;
      transformType = 'BLOCK';
      addedReasonCodes.push('DLP_TRANSFORM_EVIDENCE_MISSING');
      degradationReasons.push('DLP_TRANSFORM_EVIDENCE_MISSING');
    } else {
      const transformed = transformDlpText(originalText, entities, {
        evidenceHmacKey: options.evidenceHmacKey,
        tokenizationHmacKey: options.tokenizationHmacKey,
      });
      transformedText = transformed.blocked ? PLATFORM_FIXED_SAFE_RESPONSE : transformed.transformedText;
      action = transformed.blocked ? 'BLOCK' : action;
      transformType = transformed.blocked ? 'BLOCK' : 'MASK';
      ranges = transformedRanges(transformed.ranges);
      degradationReasons.push(...transformed.degradationReasons);
      if (transformed.blocked) addedReasonCodes.push('DLP_TRANSFORM_BLOCKED');
    }
    } catch {
      action = 'BLOCK';
      transformedText = PLATFORM_FIXED_SAFE_RESPONSE;
      transformType = 'BLOCK';
      addedReasonCodes.push('DLP_TRANSFORM_ENTITY_INVALID');
      degradationReasons.push('DLP_TRANSFORM_ENTITY_INVALID');
    }
  } else if (action === 'REWRITE') {
    const template = renderResponseTemplate(
      templates(bundle),
      { riskType, action: 'REWRITE', context },
      safeTemplateVariables(request, riskType),
    );
    if (template.ok) {
      transformedText = template.text;
      templateId = template.templateId;
      templateVersion = template.templateVersion;
    } else {
      templateFallback = true;
      transformedText = rewriteInsuranceOutput(originalText, context.legalDisclaimerVersion);
      if (template.reasonCode !== 'TEMPLATE_NOT_FOUND') {
        addedReasonCodes.push(template.reasonCode ?? 'TEMPLATE_RENDER_FAILED');
      }
    }
    transformType = 'REWRITE';
  } else if (action === 'SAFE_RESPONSE' || action === 'REQUIRE_REVIEW' || action === 'BLOCK') {
    const template = renderResponseTemplate(
      templates(bundle),
      { riskType, action, context },
      safeTemplateVariables(request, riskType),
    );
    transformedText = template.ok
      ? template.text
      : action === 'REQUIRE_REVIEW'
        ? PLATFORM_REVIEW_RESPONSE
        : PLATFORM_FIXED_SAFE_RESPONSE;
    templateId = template.templateId;
    templateVersion = template.templateVersion;
    transformType = action;
    if (!template.ok) {
      templateFallback = true;
      addedReasonCodes.push(template.reasonCode ?? 'TEMPLATE_RENDER_FAILED');
    }
  }

  if (!options.deferRecheck && transformedText !== undefined && TRANSFORM_RECHECK_ACTIONS.has(action)) {
    const outputHash = createHash('sha256').update(transformedText, 'utf8').digest('hex');
    try {
      if (request.context.absoluteDeadlineEpochMs <= now()) throw new Error('OUTPUT_RECHECK_DEADLINE_EXCEEDED');
      const parents = resolveContextEnvelopes(request, now());
      validateActionIntent(request, parents, now());
      const envelope = deriveContextEnvelope({
        content: transformedText,
        sourceType: 'AGENT',
        sourceId: 'output-recheck:' + outputHash,
        parents,
        eventSeq: Math.max(...parents.map(parent => parent.eventSeq)) + 1,
        policyVersion: String(bundle.payload.policyVersion),
      });
      // This pass evaluates derived output content. Original action authorization
      // was validated against its original sources; it cannot be rebound to AGENT text.
      const recheck = await options.evaluateRecheck({
        ...request,
        actionIntent: undefined,
        context: {
          ...request.context,
          requestId: boundedRecheckRequestId(request.context.requestId, outputHash),
          direction: 'OUTPUT_COMPLETE',
          stage: 'OUTPUT_POST',
        },
        content: { ...request.content, text: transformedText, envelopes: [envelope] },
      });
      recheckDecisionId = recheck.decisionId;
      const unavailable = Boolean(recheck.degraded || recheck.degradationReasons.length || (recheck.failMode && recheck.failMode !== 'NORMAL'));
      const recheckFailed = unavailable || !['ALLOW', 'WARN'].includes(recheck.action) ||
        matched(recheck).some((observation) => isOutputRedline(observation.riskType));
      recheckStatus = recheckFailed ? 'failed' : 'completed';
      if (recheckFailed) {
        action = 'BLOCK';
        transformedText = PLATFORM_FIXED_SAFE_RESPONSE;
        transformType = 'BLOCK';
        const reason=unavailable?'OUTPUT_RECHECK_UNAVAILABLE':matched(recheck).some(observation=>isOutputRedline(observation.riskType))?'OUTPUT_RECHECK_REDLINE_MATCH':'OUTPUT_RECHECK_CONSTRAINT_UNRESOLVED';
        addedReasonCodes.push(reason);
        if(unavailable)degradationReasons.push(reason,...recheck.degradationReasons.map(code=>'recheck:'+code));
        for(const observation of recheck.observations.slice(0,128))recheckObservations.push({...observation,
          evidence:observation.evidence.slice(0,16).map(item=>({
            viewId:'output_recheck:'+outputHash,contentHmac:item.contentHmac,maskedPreview:item.maskedPreview,
            sourceEnvelopeIds:[envelope.envelopeId],
          })),
        });
        addedReasonCodes.push(...(recheck.reasonCodes??[]).map(code=>'OUTPUT_RECHECK:'+code));
      }
    } catch (error) {
      recheckStatus = 'failed';
      degradationReasons.push('OUTPUT_RECHECK_FAILED');
      action = 'BLOCK';
      transformedText = PLATFORM_FIXED_SAFE_RESPONSE;
      transformType = 'BLOCK';
      addedReasonCodes.push(
        error instanceof Error && error.message === 'OUTPUT_RECHECK_DEADLINE_EXCEEDED'
          ? error.message
          : 'OUTPUT_RECHECK_FAILED',
      );
    }
  }

  const outputHash = transformedText === undefined
    ? undefined
    : createHash('sha256').update(transformedText, 'utf8').digest('hex');
  if (addedReasonCodes.length > 0) {
    const eventPersisted = await emitFailure(options.securityEventSink, {
      tenantId: request.context.tenantId,
      applicationId: request.context.applicationId,
      traceId: request.context.traceId,
      requestId: request.context.requestId,
      policyBundleId: bundle.id,
      action,
      reasonCode: addedReasonCodes[0]!,
      riskType,
      templateId,
      templateVersion,
      recheckDecisionId,
      contentHmac: matched(decision)[0]?.evidence[0]?.contentHmac,
      recheckReasons:recheckObservations.flatMap(observation=>observation.reasonCode?[observation.reasonCode]:[]).slice(0,32),
    });
    if (!eventPersisted) degradationReasons.push('OUTPUT_SECURITY_EVENT_PERSIST_FAILED');
  }

  const interventionMs = Math.max(0, now() - startedAt);
  observeOutputControl({
    domain: riskType.split('.').slice(0, 2).join('.'),
    action,
    locale: context.locale,
    jurisdiction: context.jurisdiction,
    industry: context.industry,
    recheck: recheckStatus,
    latencyMs: interventionMs,
    entityTypes: ranges.map((range) => range.entityType),
    templateFallback,
  });

  const transform: DecisionTransform | undefined = transformType && outputHash
    ? {
        type: transformType,
        ranges,
        ...(templateId ? { templateId } : {}),
        ...(templateVersion ? { templateVersion } : {}),
        outputHash,
        ...(recheckDecisionId ? { recheckDecisionId } : {}),
      }
    : undefined;
  const score = Math.max(riskScore(decision), ...recheckObservations.filter(isConfirmedObservation).map(observation => observation.score));
  return {
    ...decision,
    observations:[...decision.observations,...recheckObservations],
    action,
    riskLevel: action === 'BLOCK' && decision.riskLevel !== 'CRITICAL' ? 'HIGH' : decision.riskLevel,
    policyPath: [...decision.policyPath, 'output-control', context.policyVersion],
    latencyMs: Math.min(600_000, decision.latencyMs + interventionMs),
    latencyBreakdown: {
      ...(decision.latencyBreakdown ?? {}),
      interventionMs,
      totalMs: Math.min(600_000, decision.latencyMs + interventionMs),
    },
    score,
    confidence: score,
    compliance: context,
    ...(transformedText === undefined ? {} : { transformedText }),
    ...(transform ? { transform } : {}),
    reasonCodes: [...new Set([...(decision.reasonCodes ?? []), ...addedReasonCodes])].sort(),
    degradationReasons: [...new Set(degradationReasons)].sort(),
    degraded: degradationReasons.length > 0,
    failMode: degradationReasons.length > 0 ? (action === 'BLOCK' ? 'FAIL_CLOSED' : 'DEGRADED') : decision.failMode,
    evidenceComplete: degradationReasons.length > 0 ? false : decision.evidenceComplete,
  };
}
