import type { GuardAction, GuardDecision, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';

export interface OcrFusionRegion {
  readonly text: string;
  readonly artifactId: string;
  readonly viewId: string;
  readonly region: readonly [number, number, number, number];
}

export interface VisualFusionFinding {
  readonly riskType: string;
  readonly score: number;
  readonly artifactId: string;
  readonly viewId: string;
  readonly region?: readonly [number, number, number, number];
  readonly reasonCode: string;
}

interface SegmentSpan {
  readonly start: number;
  readonly end: number;
  readonly source: 'user_text' | 'image_ocr';
  readonly artifactId?: string;
  readonly viewId?: string;
  readonly region?: readonly [number, number, number, number];
}

type InputSegment = Omit<SegmentSpan, 'start' | 'end'> & { readonly text: string };

const ACTION_RANK: Readonly<Record<GuardAction, number>> = {
  ALLOW: 0, WARN: 1, MASK: 2, REWRITE: 2, REQUIRE_REVIEW: 3, SAFE_RESPONSE: 4, BLOCK: 5,
};

function buildText(segments: readonly InputSegment[]) {
  let text = '';
  const spans: SegmentSpan[] = [];
  for (const segment of segments) {
    const value = segment.text;
    if (!value) continue;
    if (text) text += ' ';
    const start = text.length;
    text += value;
    const { text: _text, ...provenance } = segment;
    spans.push({ ...provenance, start, end: text.length });
  }
  return { text, spans };
}

async function evaluate(
  bundle: RuntimePolicyBundle,
  base: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>,
  requestSuffix: string,
  text: string,
): Promise<GuardDecision> {
  return createEngineForPolicyBundle(bundle).evaluate({
    contractVersion: '1.0',
    context: {
      ...base,
      requestId: `${base.traceId}-${requestSuffix}`,
      direction: 'INPUT',
      policyBundleId: bundle.id,
    },
    content: { text: text || '[empty modality]' },
  });
}

function mappedEvidence(decision: GuardDecision, spans: readonly SegmentSpan[]) {
  return decision.observations.flatMap((observation) => observation.evidence.map((evidence) => {
    const matched = spans.filter((span) =>
      evidence.start !== undefined && evidence.end !== undefined &&
      evidence.end > span.start && evidence.start < span.end,
    );
    return {
      riskType: observation.riskType,
      score: observation.score,
      contentHmac: evidence.contentHmac,
      maskedPreview: evidence.maskedPreview,
      sources: matched.map((span) => ({
        source: span.source,
        artifactId: span.artifactId,
        viewId: span.viewId,
        region: span.region,
      })),
    };
  }));
}

export async function fuseMultimodal(input: {
  readonly bundle: RuntimePolicyBundle;
  readonly context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>;
  readonly userText?: string;
  readonly contextArtifactId?: string;
  readonly ocr: readonly OcrFusionRegion[];
  readonly visual: readonly VisualFusionFinding[];
  readonly anomalyScore?: number;
}) {
  const user = buildText(input.userText ? [{
    text: input.userText,
    source: 'user_text' as const,
    artifactId: input.contextArtifactId,
  }] : []);
  const image = buildText(input.ocr.map((region) => ({
    text: region.text,
    source: 'image_ocr' as const,
    artifactId: region.artifactId,
    viewId: region.viewId,
    region: region.region,
  })));
  const combined = buildText([
    ...(input.userText ? [{ text: input.userText, source: 'user_text' as const, artifactId: input.contextArtifactId }] : []),
    ...input.ocr.map((region) => ({
      text: region.text, source: 'image_ocr' as const, artifactId: region.artifactId,
      viewId: region.viewId, region: region.region,
    })),
  ]);
  const [userDecision, imageDecision, combinedDecision] = await Promise.all([
    evaluate(input.bundle, input.context, 'user', user.text),
    evaluate(input.bundle, input.context, 'image', image.text),
    evaluate(input.bundle, input.context, 'combined', combined.text),
  ]);
  const strongestIndividual = Math.max(ACTION_RANK[userDecision.action], ACTION_RANK[imageDecision.action]);
  const cooperativeAttack = Boolean(input.userText && input.ocr.length > 0 &&
    ACTION_RANK[combinedDecision.action] > strongestIndividual);
  const visualScore = Math.max(input.anomalyScore ?? 0, 0, ...input.visual.map((item) => item.score));
  const visualAction: GuardAction = visualScore >= 0.8 ? 'BLOCK' : visualScore >= 0.5 ? 'WARN' : 'ALLOW';
  const finalAction = ACTION_RANK[visualAction] > ACTION_RANK[combinedDecision.action]
    ? visualAction : combinedDecision.action;
  return {
    action: finalAction,
    cooperativeAttack,
    textDecisions: { user: userDecision, image: imageDecision, combined: combinedDecision },
    evidence: [
      ...mappedEvidence(combinedDecision, combined.spans),
      ...input.visual.map((item) => ({
        riskType: item.riskType,
        score: item.score,
        reasonCode: item.reasonCode,
        sources: [{ source: 'visual', artifactId: item.artifactId, viewId: item.viewId, region: item.region }],
      })),
    ],
  };
}
