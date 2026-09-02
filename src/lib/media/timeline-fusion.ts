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

interface Span extends TimelineTextSegment { readonly start: number; readonly end: number }

const RANK: Readonly<Record<GuardAction, number>> = {
  ALLOW: 0, WARN: 1, MASK: 2, REWRITE: 2, REQUIRE_REVIEW: 3, SAFE_RESPONSE: 4, BLOCK: 5,
};

function document(segments: readonly TimelineTextSegment[]) {
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
  return decisionValue.observations.flatMap((observation) => observation.evidence.map((item) => {
    const span = spans.find((candidate) => item.start !== undefined && item.end !== undefined &&
      item.end > candidate.start && item.start < candidate.end);
    return {
      riskType: observation.riskType,
      score: observation.score,
      action: decisionValue.action,
      startMs: span?.startMs,
      endMs: span?.endMs,
      frameIndex: span?.frameIndex,
      contentHmac: item.contentHmac,
      reasonCode: observation.reasonCode ?? 'MEDIA_TEXT_RISK',
    };
  }));
}

export async function fuseMediaTimeline(input: {
  bundle: RuntimePolicyBundle;
  context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>;
  segments: readonly TimelineTextSegment[];
  visual: readonly TimelineVisualRisk[];
  anomalyScore?: number;
}) {
  const audio = document(input.segments.filter((item) => item.source === 'audio'));
  const frames = document(input.segments.filter((item) => item.source === 'frame_ocr'));
  const combined = document(input.segments);
  const [audioDecision, frameDecision, combinedDecision] = await Promise.all([
    decision(input.bundle, input.context, 'audio', audio.text),
    decision(input.bundle, input.context, 'frames', frames.text),
    decision(input.bundle, input.context, 'combined', combined.text),
  ]);
  const cooperativeAttack = audio.text.length > 0 && frames.text.length > 0 &&
    RANK[combinedDecision.action] > Math.max(RANK[audioDecision.action], RANK[frameDecision.action]);
  const visualScore = Math.max(input.anomalyScore ?? 0, 0, ...input.visual.map((item) => item.score));
  const visualAction: GuardAction = visualScore >= 0.8 ? 'BLOCK' : visualScore >= 0.5 ? 'WARN' : 'ALLOW';
  const action = RANK[visualAction] > RANK[combinedDecision.action] ? visualAction : combinedDecision.action;
  return {
    action,
    cooperativeAttack,
    decisions: { audio: audioDecision, frames: frameDecision, combined: combinedDecision },
    evidence: [
      ...evidence(combinedDecision, combined.spans),
      ...input.visual.map((item) => ({
        ...item, startMs: item.timeMs, endMs: item.timeMs, action: visualAction,
      })),
    ],
  };
}
