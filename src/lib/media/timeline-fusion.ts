import type { GuardAction, GuardDecision, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';

export interface TimelineTextSegment {
  readonly source: 'audio' | 'frame_ocr';
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly frameIndex?: number;
}

export interface TimelineVisualRisk {
  readonly riskType: string;
  readonly score: number;
  readonly timeMs: number;
  readonly frameIndex: number;
  readonly region?: readonly [number, number, number, number];
  readonly reasonCode: string;
}

interface DocumentSegment {
  readonly source: 'user_text' | TimelineTextSegment['source'];
  readonly text: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly frameIndex?: number;
  readonly artifactId?: string;
}

interface Span extends DocumentSegment { readonly start: number; readonly end: number }

const RANK: Readonly<Record<GuardAction, number>> = {
  ALLOW: 0, WARN: 1, MASK: 2, REWRITE: 2, REQUIRE_REVIEW: 3, SAFE_RESPONSE: 4, BLOCK: 5,
};

function document(segments: readonly DocumentSegment[]) {
  let text = '';
  const spans: Span[] = [];
  for (const segment of segments) {
    if (text) text += ' ';
    const start = text.length;
    text += segment.text;
    spans.push({ ...segment, start, end: text.length });
  }
  return { text, spans };
}

function ordered(segments: readonly TimelineTextSegment[]): TimelineTextSegment[] {
  return [...segments].sort((left, right) =>
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.source.localeCompare(right.source) ||
    (left.frameIndex ?? -1) - (right.frameIndex ?? -1),
  );
}

function timeClusters(
  segments: readonly TimelineTextSegment[],
  windowMs: number,
): TimelineTextSegment[][] {
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

async function decision(bundle: RuntimePolicyBundle, context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>, suffix: string, text: string) {
  return createEngineForPolicyBundle(bundle).evaluate({
    contractVersion: '1.0',
    context: {
      ...context, requestId: `${context.traceId}-${suffix}`,
      direction: 'INPUT', policyBundleId: bundle.id,
    },
    content: { text: text || '[empty media track]' },
  });
}

function evidence(decisionValue: GuardDecision, spans: readonly Span[]) {
  return decisionValue.observations.flatMap((observation) => observation.evidence.flatMap((item) => {
    const matched = spans.filter((candidate) => item.start !== undefined && item.end !== undefined &&
      item.end > candidate.start && item.start < candidate.end);
    const sources: readonly (Span | undefined)[] = matched.length > 0 ? matched : [undefined];
    return sources.map((span) => ({
      riskType: observation.riskType,
      score: observation.score,
      action: decisionValue.action,
      source: span?.source,
      artifactId: span?.artifactId,
      startMs: span?.startMs,
      endMs: span?.endMs,
      frameIndex: span?.frameIndex,
      contentHmac: item.contentHmac,
      reasonCode: observation.reasonCode ?? 'MEDIA_TEXT_RISK',
    }));
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

export async function fuseMediaTimeline(input: {
  bundle: RuntimePolicyBundle;
  context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>;
  userText?: string;
  contextArtifactId?: string;
  segments: readonly TimelineTextSegment[];
  visual: readonly TimelineVisualRisk[];
  anomalyScore?: number;
  crossModalWindowMs?: number;
  reviewThreshold?: number;
  blockThreshold?: number;
}) {
  const sorted = ordered(input.segments);
  const userSegment: DocumentSegment[] = input.userText
    ? [{
        source: 'user_text',
        text: input.userText,
        artifactId: input.contextArtifactId,
      }]
    : [];
  const user = document(userSegment);
  const audio = document(sorted.filter((item) => item.source === 'audio'));
  const frames = document(sorted.filter((item) => item.source === 'frame_ocr'));
  const combinedDocuments = timeClusters(
    sorted,
    input.crossModalWindowMs ?? 30_000,
  ).map((cluster) => document([...userSegment, ...cluster]));
  const [userDecision, audioDecision, frameDecision, combinedCandidates] = await Promise.all([
    decision(input.bundle, input.context, 'user', user.text),
    decision(input.bundle, input.context, 'audio', audio.text),
    decision(input.bundle, input.context, 'frames', frames.text),
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
    ...(frames.text ? [frameDecision] : []),
  ];
  const cooperativeAttack = individual.length >= 2 &&
    RANK[combinedDecision.action] > Math.max(...individual.map((item) => RANK[item.action]));
  const visualScore = Math.max(input.anomalyScore ?? 0, 0, ...input.visual.map((item) => item.score));
  const visualAction = actionForScore(
    visualScore,
    input.reviewThreshold ?? 0.65,
    input.blockThreshold ?? 0.8,
  );
  const action = RANK[visualAction] > RANK[combinedDecision.action] ? visualAction : combinedDecision.action;
  return {
    action,
    cooperativeAttack,
    decisions: {
      user: userDecision,
      audio: audioDecision,
      frames: frameDecision,
      combined: combinedDecision,
    },
    evidence: [
      ...evidence(combinedDecision, selectedCombined.spans),
      ...input.visual.map((item) => ({
        ...item,
        source: 'visual' as const,
        startMs: item.timeMs,
        endMs: item.timeMs,
        action: actionForScore(
          item.score,
          input.reviewThreshold ?? 0.65,
          input.blockThreshold ?? 0.8,
        ),
      })),
    ],
  };
}
