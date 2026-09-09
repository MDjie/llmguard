import { fusionSourceContent, type FusionSourceSpan } from '@/lib/multimodal/source-content';
import { inspectRiskRelations } from '@/lib/guard-engine-v2/risk-relations';
import { makeEvidenceView } from '@/lib/evidence/media-views';
import { validateEvidenceLocation } from '@/lib/evidence/location';
import { createHash } from 'node:crypto';
import type { GuardAction, GuardDecision, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { ACTION_PRIORITY, combineActionConstraints } from '@/lib/guard-engine-v2/action-constraints';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import { assessAnalysisCoverage,type AnalysisCoverage } from '@/lib/multimodal/coverage';
import { planTimelineWindows } from './timeline-windows';

export type TimelineSource = 'audio' | 'subtitle' | 'frame_ocr' | 'qr_code';
export interface TimelineTextSegment {
  readonly artifactId?: string;
  readonly artifactSha256?: string;
  readonly source: TimelineSource;
  readonly confidence?: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly frameIndex?: number;
  readonly viewId?: string;
  readonly speakerId?: string;
  readonly channel?: number;
}

export interface TimelineVisualRisk {
  readonly riskType: string;
  readonly score: number;
  readonly timeMs: number;
  readonly frameIndex: number;
  readonly region?: readonly [number, number, number, number];
  readonly reasonCode: string;
}

export interface MediaAnalysisFailure {
  readonly component: string;
  readonly required: boolean;
  readonly code: string;
}

interface DocumentSegment {
  readonly source: 'user_text' | TimelineSource;
  readonly text: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly frameIndex?: number;
  readonly viewId?: string;
  readonly speakerId?: string;
  readonly channel?: number;
  readonly artifactId?: string;
  readonly artifactSha256?: string;
}
interface Span extends DocumentSegment { readonly start: number; readonly end: number }


function document(segments: readonly DocumentSegment[]) {
  let text = '';
  const spans: Span[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    if (text) text += ' ';
    const start = text.length;
    text += segment.text;
    spans.push({ ...segment, start, end: text.length });
  }
  return { text, spans };
}

function ordered(segments: readonly TimelineTextSegment[]): TimelineTextSegment[] {
  return [...segments].sort((left, right) =>
    left.startMs - right.startMs || left.endMs - right.endMs ||
    left.source.localeCompare(right.source) || (left.frameIndex ?? -1) - (right.frameIndex ?? -1));
}

async function decision(
  bundle: RuntimePolicyBundle,
  context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'> &
    Partial<Pick<GuardRequest['context'], 'direction'>>,
  suffix: string,
  text: string,
  spans: readonly FusionSourceSpan[],
): Promise<GuardDecision> {
  const requestId = `${context.traceId}-${suffix}`.slice(0, 128);
  // Absent optional tracks must not invoke detectors on synthetic business content.
  // Required analysis/quality coverage is still enforced by the enclosing fusion.
  if (!text) return {
    contractVersion: '1.0', decisionId: `dec_${createHash('sha256').update(JSON.stringify([requestId, bundle.id, context.direction ?? 'INPUT'])).digest('hex').slice(0, 32)}`,
    traceId: context.traceId, action: 'ALLOW', riskLevel: 'NONE', observations: [],
    policyPath: [bundle.payload.policyId, 'modality-not-applicable'], bundleId: bundle.id,
    latencyMs: 0, degraded: false, reasonCodes: ['MODALITY_NOT_APPLICABLE'],
    degradationReasons: [], failMode: 'NORMAL', evidenceComplete: false,
  };
  return createEngineForPolicyBundle(bundle).evaluate({
    contractVersion: '1.0',
    context: {
      ...context,
      requestId,
      direction: context.direction ?? 'INPUT',
      policyBundleId: bundle.id,
    },
    content: fusionSourceContent(text, spans, { ...context, requestId, direction: context.direction ?? 'INPUT', policyBundleId: bundle.id }),
  });
}

function evidenceIdentity(traceId: string, value: unknown): string {
  return createHash('sha256').update(`${traceId}:${JSON.stringify(value)}`, 'utf8').digest('hex');
}

function evidence(decisionValue: GuardDecision, spans: readonly Span[], traceId: string) {
  return decisionValue.observations.flatMap((observation) => observation.evidence.flatMap((item) => {
    const matched = spans.filter((candidate) => item.start !== undefined && item.end !== undefined &&
      item.end > candidate.start && item.start < candidate.end);
    const sources: readonly (Span | undefined)[] = matched.length > 0 ? matched : [undefined];
    return sources.map((span) => {
      const location = validateEvidenceLocation({
        artifactId: span?.artifactId, sourceDigest: span?.artifactSha256, contentVersion: span ? createHash('sha256').update(span.text).digest('hex') : undefined,
        contentPath: '/views/' + encodeURIComponent(span?.viewId ?? span?.source ?? 'unknown'),
        mappingVersion: 'guard-evidence-location-1', offsetEncoding: 'UTF16', viewId: span?.viewId,
        textStart: span && item.start !== undefined ? Math.max(item.start, span.start) - span.start : undefined,
        textEnd: span && item.end !== undefined ? Math.min(item.end, span.end) - span.start : undefined,
        textLength: span ? span.end - span.start : undefined,
        startMs: span?.startMs, endMs: span?.endMs, frameIndex: span?.frameIndex, speakerId: span?.speakerId, channel: span?.channel,
      });
      const base = {
        locations: location.location ? [location.location] : [], locationState: location.state,
        detectorId: observation.detectorId,
        modelVersion: observation.modelVersion,
        status: observation.status, decisionRole: observation.decisionRole,
        detectorVersion: observation.detectorVersion,
        ruleId: observation.ruleId,
        ruleVersion: observation.ruleVersion,
        riskType: observation.riskType,
        score: observation.score,
        action: decisionValue.action,
        source: span?.source,
        artifactId: span?.artifactId,
        startMs: span?.startMs,
        endMs: span?.endMs,
        frameIndex: span?.frameIndex,
        viewId: span?.viewId,
        speakerId: span?.speakerId,
        channel: span?.channel,
        textStart: span && item.start !== undefined ? Math.max(item.start, span.start) - span.start : undefined,
        textEnd: span && item.end !== undefined ? Math.min(item.end, span.end) - span.start : undefined,
        contentHmac: item.contentHmac,
        reasonCode: observation.reasonCode ?? 'MEDIA_TEXT_RISK',
        traceId,
      };
      return { ...base, evidenceRef: evidenceIdentity(traceId, base) };
    });
  }));
}

function maximumObservationScore(value: GuardDecision): number {
  return Math.max(0, ...value.observations.map((item) => item.score));
}

function strongerDecision(
  left: { readonly value: GuardDecision; readonly spans: Span[] },
  right: { readonly value: GuardDecision; readonly spans: Span[] },
) {
  const rankDifference = ACTION_PRIORITY[right.value.action] - ACTION_PRIORITY[left.value.action];
  if (rankDifference > 0) return right;
  if (rankDifference < 0) return left;
  return maximumObservationScore(right.value) > maximumObservationScore(left.value) ? right : left;
}

function actionForScore(score: number, reviewThreshold: number, blockThreshold: number): GuardAction {
  if (score >= blockThreshold) return 'BLOCK';
  if (score >= reviewThreshold) return 'REQUIRE_REVIEW';
  if (score >= 0.5) return 'WARN';
  return 'ALLOW';
}

function trackConflict(
  segments: readonly TimelineTextSegment[],
  audioDecision: GuardDecision,
  subtitleDecision: GuardDecision,
): boolean {
  if (audioDecision.action === 'ALLOW' && subtitleDecision.action === 'ALLOW') return false;
  const audio = segments.filter((item) => item.source === 'audio');
  const subtitles = segments.filter((item) => item.source === 'subtitle');
  return audio.some((left) => subtitles.some((right) =>
    right.endMs >= left.startMs && left.endMs >= right.startMs &&
    left.text.normalize('NFKC').toLowerCase() !== right.text.normalize('NFKC').toLowerCase()));
}

export async function fuseMediaTimeline(input: {
  analysisCoverage?:AnalysisCoverage;artifactSha256?:string;
  artifactId?: string;
  bundle: RuntimePolicyBundle;
  context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'> &
    Partial<Pick<GuardRequest['context'], 'direction'>>;
  userText?: string;
  contextArtifactId?: string;
  segments: readonly TimelineTextSegment[];
  visual: readonly TimelineVisualRisk[];
  analysisFailures?: readonly MediaAnalysisFailure[];
  sourceTrust?: 'TRUSTED' | 'CONTROLLED' | 'UNTRUSTED' | 'UNKNOWN';
  instructionCapability?: 'ALLOWED' | 'DATA_ONLY' | 'FORBIDDEN' | 'UNKNOWN';
  anomalyScore?: number;
  crossModalWindowMs?: number;
  minimumConfidence?: number;
  reviewThreshold?: number;
  blockThreshold?: number;
}) {
  const sorted = ordered(input.segments.map(segment => ({ ...segment, artifactId: segment.artifactId ?? input.artifactId, artifactSha256: segment.artifactSha256 ?? input.artifactSha256 })));
  const userSegment: DocumentSegment[] = input.userText ? [{
    source: 'user_text', text: input.userText, artifactId: input.contextArtifactId, artifactSha256: input.contextArtifactId ? createHash('sha256').update(input.userText).digest('hex') : undefined,
  }] : [];
  const user = document(userSegment);
  const audio = document(sorted.filter((item) => item.source === 'audio'));
  const subtitles = document(sorted.filter((item) => item.source === 'subtitle'));
  const frames = document(sorted.filter((item) => item.source === 'frame_ocr'));
  const codes = document(sorted.filter((item) => item.source === 'qr_code'));
  const windowPlan = planTimelineWindows(sorted, { windowMs: input.crossModalWindowMs ?? 30_000 });
  const combinedDocuments = (windowPlan.windows.length ? windowPlan.windows.map(window => window.segments) : [[]])
    .map((cluster) => document([...userSegment, ...cluster]));
  const [userDecision, audioDecision, subtitleDecision, frameDecision, codeDecision, combinedCandidates] = await Promise.all([
    decision(input.bundle, input.context, 'user', user.text, user.spans),
    decision(input.bundle, input.context, 'audio', audio.text, audio.spans),
    decision(input.bundle, input.context, 'subtitles', subtitles.text, subtitles.spans),
    decision(input.bundle, input.context, 'frames', frames.text, frames.spans),
    decision(input.bundle, input.context, 'codes', codes.text, codes.spans),
    Promise.all(combinedDocuments.map(async (item, index) => ({
      value: await decision(input.bundle, input.context, `combined-${index}`, item.text, item.spans),
      spans: item.spans,
    }))),
  ]);
  const selectedCombined = combinedCandidates.reduce(strongerDecision);
  const combinedDecision = selectedCombined.value;
  const individual = [
    ...(user.text ? [userDecision] : []),
    ...(audio.text ? [audioDecision] : []),
    ...(subtitles.text ? [subtitleDecision] : []),
    ...(frames.text ? [frameDecision] : []),
    ...(codes.text ? [codeDecision] : []),
  ];
  const relationSegments:readonly DocumentSegment[]=[...userSegment,...sorted];
  const relationship=inspectRiskRelations(relationSegments.map((segment,index)=>({
    id:'source-'+index,text:segment.text,sourceType:segment.source==='user_text'?'USER':'MEDIA',
    instructionCapability:segment.source==='user_text'?'ALLOWED':'FORBIDDEN',objectRef:segment.artifactId,
    startMs:segment.startMs,endMs:segment.endMs,
  })));
  const confirmedRelations=relationship.relations.filter(relation=>relation.status==='CONFIRMED'&&relation.sourceEnvelopeIds.length>1);
  const cooperativeAttack=confirmedRelations.length>0;
  const relationAction:GuardAction=cooperativeAttack?'BLOCK':relationship.coverage==='PARTIAL'?'REQUIRE_REVIEW':'ALLOW';
  const relationEvidence=confirmedRelations.map(relation=>{
    const base={riskType:'prompt_injection.relation',score:0.96,action:'BLOCK' as const,
      reasonCode:'MULTIMODAL_RELATION_CONFIRMED',traceId:input.context.traceId,relation,
      sources:relation.sourceEnvelopeIds.flatMap(id=>{
        const segment=relationSegments[Number(id.slice('source-'.length))];
        if(!segment)return [];
        return [{source:segment.source,artifactId:segment.artifactId,viewId:segment.viewId}];
      })};
    return {...base,evidenceRef:evidenceIdentity(input.context.traceId,base)};
  });
  const reviewThreshold = input.reviewThreshold ?? 0.65;
  const blockThreshold = input.blockThreshold ?? 0.8;
  const visualScore = Math.max(0, ...input.visual.map((item) => item.score));
  const visualAction = actionForScore(visualScore, reviewThreshold, blockThreshold);
  // Rotation, noise and decoder disagreement are investigation signals, not confirmed harmful content.
  const anomalyAction:GuardAction=(input.anomalyScore??0)>=reviewThreshold?'REQUIRE_REVIEW':'ALLOW';
  const conflict = trackConflict(sorted, audioDecision, subtitleDecision);
  const lowConfidence = input.segments.some(item => item.confidence !== undefined &&
    (!Number.isFinite(item.confidence) || item.confidence < (input.minimumConfidence ?? 0.35) || item.confidence > 1));
  const failures = [...(input.analysisFailures ?? []),
    ...(lowConfidence ? [{ component: 'TEXT_EXTRACTION', required: true, code: 'MEDIA_EXTRACTION_CONFIDENCE_INSUFFICIENT' }] : [])];
  const failureAction: GuardAction = failures.some((item) => item.required)
    ? 'REQUIRE_REVIEW'
    : failures.length > 0
      ? 'WARN'
      : 'ALLOW';
  const trustAction: GuardAction = input.instructionCapability === 'UNKNOWN'
    ? 'REQUIRE_REVIEW'
    : input.sourceTrust === 'UNKNOWN'
      ? 'REQUIRE_REVIEW'
      : input.sourceTrust === 'UNTRUSTED' &&
          input.instructionCapability !== 'FORBIDDEN' &&
          (sorted.length > 0 || Boolean(input.userText))
        ? 'WARN'
        : 'ALLOW';
  const coverage=assessAnalysisCoverage({coverage:input.analysisCoverage,artifactSha256:input.artifactSha256,...input.context,requiredRiskIds:input.bundle.payload.semanticCoverage?.requiredRiskIds??[],combination:input.userText ? 'TEXT+' + (input.analysisCoverage?.modality ?? 'MEDIA') : input.analysisCoverage?.modality});
  const { action } = combineActionConstraints([
    ...(!windowPlan.complete ? ['REQUIRE_REVIEW' as const] : []),
    ...individual.map((item) => item.action),
    ...combinedCandidates.map((item) => item.value.action), relationAction,
    input.bundle.payload.semanticDecisionMode==='coverage-v1'&&!coverage.complete?'REQUIRE_REVIEW' as const:'ALLOW' as const,
    visualAction,
    anomalyAction,
    conflict ? 'REQUIRE_REVIEW' as const : 'ALLOW' as const,
    failureAction,
    trustAction,
  ]);
  const visualEvidence = input.visual.map((item) => {
    const position = validateEvidenceLocation({ artifactId: input.artifactId, sourceDigest: input.artifactSha256, contentVersion: input.artifactSha256,
      contentPath: `/frames/${item.frameIndex}`, mappingVersion: 'guard-evidence-location-1', offsetEncoding: 'UTF16', frameIndex: item.frameIndex,
      startMs: item.timeMs, endMs: item.timeMs, region: item.region });
    const base = {
      locations: position.location ? [position.location] : [], locationState: position.state,
      ...item,
      source: 'visual' as const,
      startMs: item.timeMs,
      endMs: item.timeMs,
      action: actionForScore(item.score, reviewThreshold, blockThreshold),
      traceId: input.context.traceId,
    };
    return { ...base, evidenceRef: evidenceIdentity(input.context.traceId, base) };
  });
  const failureEvidence = failures.map((item) => {
    const base = {
      riskType: 'system.multimodal_analysis_failure',
      score: 0, scoreMeaning:'UNCALIBRATED' as const,status:'UNKNOWN' as const,decisionRole:'CANDIDATE' as const,
      action: item.required ? 'REQUIRE_REVIEW' as const : 'WARN' as const,
      source: 'analysis_component' as const,
      reasonCode: item.code,
      traceId: input.context.traceId,
    };
    return { ...base, evidenceRef: evidenceIdentity(input.context.traceId, base) };
  });
  const conflictEvidence = conflict ? (() => {
    const base = {
      riskType: 'media.track_conflict', score: 0.75, action: 'REQUIRE_REVIEW' as const,
      source: 'audio_subtitle_conflict' as const, reasonCode: 'MEDIA_AUDIO_SUBTITLE_CONFLICT',
      traceId: input.context.traceId,
    };
    return [{ ...base, evidenceRef: evidenceIdentity(input.context.traceId, base) }];
  })() : [];
  const textEvidence = [
    ...evidence(userDecision, user.spans, input.context.traceId),
    ...evidence(audioDecision, audio.spans, input.context.traceId),
    ...evidence(subtitleDecision, subtitles.spans, input.context.traceId),
    ...evidence(frameDecision, frames.spans, input.context.traceId),
    ...evidence(codeDecision, codes.spans, input.context.traceId),
    ...combinedCandidates.flatMap((item) => evidence(item.value, item.spans, input.context.traceId)),
  ];
  return {
    privateEvidenceViews: [...user.spans,...audio.spans,...subtitles.spans,...frames.spans,...codes.spans].flatMap(segment=>segment.artifactId&&segment.artifactSha256?[makeEvidenceView({artifactId:segment.artifactId,sourceDigest:segment.artifactSha256,text:segment.text,source:segment.source,
      contentPath:'/views/'+encodeURIComponent(segment.viewId??segment.source),viewId:segment.viewId,startMs:segment.startMs,endMs:segment.endMs,frameIndex:segment.frameIndex,speakerId:segment.speakerId,channel:segment.channel})]:[]),
    action,
    coverage,
    windowCoverage: { ...windowPlan, windows: windowPlan.windows.map(({ startMs, endMs, segments }) => ({ startMs, endMs, segmentCount: segments.length })) },
    cooperativeAttack,
    relationship: { ...relationship,evidence:relationship.evidence },
    evidenceConflict: conflict,
    degraded: [...individual, ...combinedCandidates.map(item => item.value)].some(value => value.degraded || value.degradationReasons.length > 0) || relationship.coverage==='PARTIAL' || failures.length > 0 || !windowPlan.complete || (input.bundle.payload.semanticDecisionMode === 'coverage-v1' && !coverage.complete),
    decisions: {
      user: userDecision,
      audio: audioDecision,
      subtitles: subtitleDecision,
      frames: frameDecision,
      codes: codeDecision,
      combined: combinedDecision,
    },
    evidence: [
      ...relationEvidence,
      ...new Map(textEvidence.map((item) => [item.evidenceRef, item])).values(),
      ...visualEvidence,
      ...conflictEvidence,
      ...failureEvidence,
    ],
  };
}
