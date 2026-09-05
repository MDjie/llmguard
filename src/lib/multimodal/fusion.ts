import { createHash } from 'node:crypto';
import type { GuardAction, GuardDecision, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import { assessAnalysisCoverage,type AnalysisCoverage } from './coverage';

export interface OcrFusionRegion {
  readonly text: string;
  readonly artifactId: string;
  readonly viewId: string;
  readonly region: readonly [number, number, number, number];
  readonly page?: number;
}

export interface CodeFusionRegion extends OcrFusionRegion {
  readonly kind: 'QR' | 'BARCODE' | 'DATA_MATRIX';
  readonly confidence: number;
}

export interface VisualFusionFinding {
  readonly riskType: string;
  readonly score: number;
  readonly artifactId: string;
  readonly viewId: string;
  readonly region?: readonly [number, number, number, number];
  readonly reasonCode: string;
}

export interface MultimodalAnalysisFailure {
  readonly component: string;
  readonly required: boolean;
  readonly code: string;
}

type SegmentSource = 'user_text' | 'image_ocr' | 'qr_code';
interface SegmentSpan {
  readonly start: number;
  readonly end: number;
  readonly source: SegmentSource;
  readonly artifactId?: string;
  readonly viewId?: string;
  readonly region?: readonly [number, number, number, number];
  readonly page?: number;
}
type InputSegment = Omit<SegmentSpan, 'start' | 'end'> & { readonly text: string };

const ACTION_RANK: Readonly<Record<GuardAction, number>> = {
  ALLOW: 0, WARN: 1, MASK: 2, REWRITE: 2, REQUIRE_REVIEW: 3, SAFE_RESPONSE: 4, BLOCK: 5,
};

function stronger(left: GuardAction, right: GuardAction): GuardAction {
  return ACTION_RANK[right] > ACTION_RANK[left] ? right : left;
}

function actionForScore(score: number, reviewThreshold: number, blockThreshold: number): GuardAction {
  if (score >= blockThreshold) return 'BLOCK';
  if (score >= reviewThreshold) return 'REQUIRE_REVIEW';
  if (score >= 0.5) return 'WARN';
  return 'ALLOW';
}

function buildText(segments: readonly InputSegment[]) {
  let text = '';
  const spans: SegmentSpan[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    if (text) text += ' ';
    const start = text.length;
    text += segment.text;
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
      requestId: `${base.traceId}-${requestSuffix}`.slice(0, 128),
      direction: 'INPUT',
      policyBundleId: bundle.id,
    },
    content: { text: text || '[empty modality]' },
  });
}

function evidenceIdentity(traceId: string, value: unknown): string {
  return createHash('sha256')
    .update(`${traceId}:${JSON.stringify(value)}`, 'utf8')
    .digest('hex');
}

function mappedEvidence(
  decision: GuardDecision,
  spans: readonly SegmentSpan[],
  traceId: string,
) {
  return decision.observations.flatMap((observation) => observation.evidence.map((evidence) => {
    const matched = spans.filter((span) =>
      evidence.start !== undefined && evidence.end !== undefined &&
      evidence.end > span.start && evidence.start < span.end,
    );
    const sources = matched.map((span) => ({
      source: span.source,
      artifactId: span.artifactId,
      viewId: span.viewId,
      region: span.region,
      page: span.page,
    }));
    const base = {
      riskType: observation.riskType,
      score: observation.score,
      action: decision.action,
      reasonCode: observation.reasonCode ?? 'MULTIMODAL_TEXT_RISK',
      contentHmac: evidence.contentHmac,
      maskedPreview: evidence.maskedPreview,
      sources,
      traceId,
    };
    return { ...base, evidenceRef: evidenceIdentity(traceId, base) };
  }));
}

export async function fuseMultimodal(input: {
  readonly analysisCoverage?:AnalysisCoverage;readonly artifactSha256?:string;
  readonly bundle: RuntimePolicyBundle;
  readonly context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'>;
  readonly userText?: string;
  readonly contextArtifactId?: string;
  readonly ocr: readonly OcrFusionRegion[];
  readonly codes?: readonly CodeFusionRegion[];
  readonly visual: readonly VisualFusionFinding[];
  readonly analysisFailures?: readonly MultimodalAnalysisFailure[];
  readonly sourceTrust?: 'TRUSTED' | 'CONTROLLED' | 'UNTRUSTED' | 'UNKNOWN';
  readonly instructionCapability?: 'ALLOWED' | 'DATA_ONLY' | 'FORBIDDEN' | 'UNKNOWN';
  readonly anomalyScore?: number;
  readonly reviewThreshold?: number;
  readonly blockThreshold?: number;
}) {
  const userSegments: InputSegment[] = input.userText ? [{
    text: input.userText,
    source: 'user_text',
    artifactId: input.contextArtifactId,
  }] : [];
  const ocrSegments: InputSegment[] = input.ocr.map((region) => ({
    text: region.text,
    source: 'image_ocr',
    artifactId: region.artifactId,
    viewId: region.viewId,
    region: region.region,
    page: region.page,
  }));
  const codeSegments: InputSegment[] = (input.codes ?? []).map((region) => ({
    text: region.text,
    source: 'qr_code',
    artifactId: region.artifactId,
    viewId: region.viewId,
    region: region.region,
    page: region.page,
  }));
  const user = buildText(userSegments);
  const image = buildText(ocrSegments);
  const codes = buildText(codeSegments);
  const combined = buildText([...userSegments, ...ocrSegments, ...codeSegments]);
  const [userDecision, imageDecision, codeDecision, combinedDecision] = await Promise.all([
    evaluate(input.bundle, input.context, 'user', user.text),
    evaluate(input.bundle, input.context, 'image', image.text),
    evaluate(input.bundle, input.context, 'codes', codes.text),
    evaluate(input.bundle, input.context, 'combined', combined.text),
  ]);
  const strongestIndividual = Math.max(
    ACTION_RANK[userDecision.action],
    ACTION_RANK[imageDecision.action],
    ACTION_RANK[codeDecision.action],
  );
  const populatedModalities = [user.text, image.text, codes.text].filter(Boolean).length;
  const cooperativeAttack = populatedModalities >= 2 &&
    ACTION_RANK[combinedDecision.action] > strongestIndividual;
  const reviewThreshold = input.reviewThreshold ?? 0.65;
  const blockThreshold = input.blockThreshold ?? 0.8;
  const visualScore = Math.max(input.anomalyScore ?? 0, 0, ...input.visual.map((item) => item.score));
  const visualAction = actionForScore(visualScore, reviewThreshold, blockThreshold);
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
          input.instructionCapability !== 'FORBIDDEN' && combined.text
        ? 'WARN'
        : 'ALLOW';
  const coverage=assessAnalysisCoverage({coverage:input.analysisCoverage,artifactSha256:input.artifactSha256,...input.context,requiredRiskIds:input.bundle.payload.semanticCoverage?.requiredRiskIds??[]});
  const coverageAction:GuardAction=input.bundle.payload.semanticDecisionMode==='coverage-v1'&&!coverage.complete?'REQUIRE_REVIEW':'ALLOW';
  const action = [visualAction, failureAction, trustAction,coverageAction]
    .reduce(stronger, combinedDecision.action);
  const visualEvidence = input.visual.map((item) => {
    const base = {
      riskType: item.riskType,
      score: item.score,
      action: actionForScore(item.score, reviewThreshold, blockThreshold),
      reasonCode: item.reasonCode,
      sources: [{
        source: 'visual' as const,
        artifactId: item.artifactId,
        viewId: item.viewId,
        region: item.region,
      }],
      traceId: input.context.traceId,
    };
    return { ...base, evidenceRef: evidenceIdentity(input.context.traceId, base) };
  });
  const failureEvidence = failures.map((item) => {
    const base = {
      riskType: 'system.multimodal_analysis_failure',
      score: item.required ? 1 : 0.5,
      action: item.required ? 'BLOCK' as const : 'WARN' as const,
      reasonCode: item.code,
      sources: [{ source: 'analysis_component' as const, component: item.component }],
      traceId: input.context.traceId,
    };
    return { ...base, evidenceRef: evidenceIdentity(input.context.traceId, base) };
  });
  return {
    action,
    coverage,
    cooperativeAttack,
    degraded: failures.length > 0,
    textDecisions: {
      user: userDecision,
      image: imageDecision,
      codes: codeDecision,
      combined: combinedDecision,
    },
    evidence: [
      ...mappedEvidence(combinedDecision, combined.spans, input.context.traceId),
      ...visualEvidence,
      ...failureEvidence,
    ],
  };
}
