import { createHash } from 'node:crypto';
import type { GuardAction, GuardDecision, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';

export type TimelineSource = 'audio' | 'subtitle' | 'frame_ocr' | 'qr_code';
export interface TimelineTextSegment {
  readonly source: TimelineSource;
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
}
interface Span extends DocumentSegment { readonly start: number; readonly end: number }

const RANK: Readonly<Record<GuardAction, number>> = {
  ALLOW: 0, WARN: 1, MASK: 2, REWRITE: 2, REQUIRE_REVIEW: 3, SAFE_RESPONSE: 4, BLOCK: 5,
};

function strongerAction(left: GuardAction, right: GuardAction): GuardAction {
  return RANK[right] > RANK[left] ? right : left;
}

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

function timeClusters(segments: readonly TimelineTextSegment[], windowMs: number): TimelineTextSegment[][] {
  const sorted = ordered(segments);
  if (sorted.length === 0) return [[]];
  const clusters: TimelineTextSegment[][] = [];
  let current: TimelineTextSegment[] = [];
  let latestEnd = 0;
  for (const segment of sorted) {
    if (current.length > 0 && segment.startMs - latestEnd > windowMs) {
      clusters.push(current);
      current = [];
    }
    current.push(segment);
    latestEnd = Math.max(latestEnd, segment.endMs);
  }
  clusters.push(current);
  return clusters;
}

async function decision(
  bundle: RuntimePolicyBundle,
  context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>,
  suffix: string,
  text: string,
) {
  return createEngineForPolicyBundle(bundle).evaluate({
    contractVersion: '1.0',
    context: {
      ...context,
      requestId: `${context.traceId}-${suffix}`.slice(0, 128),
      direction: 'INPUT',
      policyBundleId: bundle.id,
    },
    content: { text: text || '[empty media track]' },
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
      const base = {
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
  const rankDifference = RANK[right.value.action] - RANK[left.value.action];
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
  bundle: RuntimePolicyBundle;
  context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>;
  userText?: string;
  contextArtifactId?: string;
  segments: readonly TimelineTextSegment[];
  visual: readonly TimelineVisualRisk[];
  analysisFailures?: readonly MediaAnalysisFailure[];
  sourceTrust?: 'TRUSTED' | 'CONTROLLED' | 'UNTRUSTED' | 'UNKNOWN';
  instructionCapability?: 'ALLOWED' | 'DATA_ONLY' | 'FORBIDDEN' | 'UNKNOWN';
  anomalyScore?: number;
  crossModalWindowMs?: number;
  reviewThreshold?: number;
  blockThreshold?: number;
}) {
  const sorted = ordered(input.segments);
  const userSegment: DocumentSegment[] = input.userText ? [{
    source: 'user_text', text: input.userText, artifactId: input.contextArtifactId,
  }] : [];
  const user = document(userSegment);
  const audio = document(sorted.filter((item) => item.source === 'audio'));
  const subtitles = document(sorted.filter((item) => item.source === 'subtitle'));
  const frames = document(sorted.filter((item) => item.source === 'frame_ocr'));
  const codes = document(sorted.filter((item) => item.source === 'qr_code'));
  const combinedDocuments = timeClusters(sorted, input.crossModalWindowMs ?? 30_000)
    .map((cluster) => document([...userSegment, ...cluster]));
  const [userDecision, audioDecision, subtitleDecision, frameDecision, codeDecision, combinedCandidates] = await Promise.all([
    decision(input.bundle, input.context, 'user', user.text),
    decision(input.bundle, input.context, 'audio', audio.text),
    decision(input.bundle, input.context, 'subtitles', subtitles.text),
    decision(input.bundle, input.context, 'frames', frames.text),
    decision(input.bundle, input.context, 'codes', codes.text),
    Promise.all(combinedDocuments.map(async (item, index) => ({
      value: await decision(input.bundle, input.context, `combined-${index}`, item.text),
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
  const cooperativeAttack = individual.length >= 2 &&
    RANK[combinedDecision.action] > Math.max(...individual.map((item) => RANK[item.action]));
  const reviewThreshold = input.reviewThreshold ?? 0.65;
  const blockThreshold = input.blockThreshold ?? 0.8;
  const visualScore = Math.max(input.anomalyScore ?? 0, 0, ...input.visual.map((item) => item.score));
  const visualAction = actionForScore(visualScore, reviewThreshold, blockThreshold);
  const conflict = trackConflict(sorted, audioDecision, subtitleDecision);
  const failures = input.analysisFailures ?? [];
  const failureAction: GuardAction = failures.some((item) => item.required)
    ? 'BLOCK'
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
  const action = [
    visualAction,
    conflict ? 'REQUIRE_REVIEW' as const : 'ALLOW' as const,
    failureAction,
    trustAction,
  ].reduce(strongerAction, combinedDecision.action);
  const visualEvidence = input.visual.map((item) => {
    const base = {
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
      score: item.required ? 1 : 0.5,
      action: item.required ? 'BLOCK' as const : 'WARN' as const,
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
  return {
    action,
    cooperativeAttack,
    evidenceConflict: conflict,
    degraded: failures.length > 0,
    decisions: {
      user: userDecision,
      audio: audioDecision,
      subtitles: subtitleDecision,
      frames: frameDecision,
      codes: codeDecision,
      combined: combinedDecision,
    },
    evidence: [
      ...evidence(combinedDecision, selectedCombined.spans, input.context.traceId),
      ...visualEvidence,
      ...conflictEvidence,
      ...failureEvidence,
    ],
  };
}
