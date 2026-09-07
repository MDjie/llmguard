import { makeEvidenceView } from '@/lib/evidence/media-views';
import { validateEvidenceLocation } from '@/lib/evidence/location';
import { createHash } from 'node:crypto';
import type { GuardAction, GuardDecision, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { ACTION_PRIORITY, combineActionConstraints } from '@/lib/guard-engine-v2/action-constraints';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import { assessAnalysisCoverage,type AnalysisCoverage } from './coverage';

export interface OcrFusionRegion {
  readonly text: string;
  readonly artifactId: string;
  readonly artifactSha256?: string;
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
  readonly artifactSha256?: string;
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
  readonly textVersion: string;
  readonly source: SegmentSource;
  readonly artifactId?: string;
  readonly artifactSha256?: string;
  readonly viewId?: string;
  readonly region?: readonly [number, number, number, number];
  readonly page?: number;
}
type InputSegment = Omit<SegmentSpan, 'start' | 'end' | 'textVersion'> & { readonly text: string };

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
    spans.push({ ...provenance, start, end: text.length, textVersion: createHash('sha256').update(segment.text).digest('hex') });
  }
  return { text, spans };
}

async function evaluate(
  bundle: RuntimePolicyBundle,
  base: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'> &
    Partial<Pick<GuardRequest['context'], 'direction'>>,
  requestSuffix: string,
  text: string,
): Promise<GuardDecision> {
  const requestId = `${base.traceId}-${requestSuffix}`.slice(0, 128);
  // Absent optional tracks must not invoke detectors on synthetic business content.
  // Required analysis/quality coverage is still enforced by the enclosing fusion.
  if (!text) return {
    contractVersion: '1.0', decisionId: `dec_${createHash('sha256').update(JSON.stringify([requestId, bundle.id, base.direction ?? 'INPUT'])).digest('hex').slice(0, 32)}`,
    traceId: base.traceId, action: 'ALLOW', riskLevel: 'NONE', observations: [],
    policyPath: [bundle.payload.policyId, 'modality-not-applicable'], bundleId: bundle.id,
    latencyMs: 0, degraded: false, reasonCodes: ['MODALITY_NOT_APPLICABLE'],
    degradationReasons: [], failMode: 'NORMAL', evidenceComplete: false,
  };
  return createEngineForPolicyBundle(bundle).evaluate({
    contractVersion: '1.0',
    context: {
      ...base,
      requestId,
      direction: base.direction ?? 'INPUT',
      policyBundleId: bundle.id,
    },
    content: { text },
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
      artifactSha256: span.artifactSha256,
      textLength: span.end - span.start, textVersion: span.textVersion,
      textStart: Math.max(evidence.start ?? span.start, span.start) - span.start,
      textEnd: Math.min(evidence.end ?? span.end, span.end) - span.start,
    }));
    const locations = sources.map(source => validateEvidenceLocation({
      artifactId: source.artifactId, sourceDigest: source.artifactSha256, contentVersion: source.textVersion,
      contentPath: '/views/' + encodeURIComponent(source.viewId ?? 'original'), mappingVersion: 'guard-evidence-location-1', offsetEncoding: 'UTF16',
      viewId: source.viewId, textStart: source.textStart, textEnd: source.textEnd, textLength: source.textLength, page: source.page, region: source.region,
    }));
    const base = {
      locations: locations.flatMap(item => item.location ? [item.location] : []),
      locationState: locations.length > 0 && locations.every(item => item.state === 'VERIFIED') ? 'VERIFIED' as const : 'UNVERIFIED' as const,
      detectorId: observation.detectorId,
      status: observation.status, decisionRole: observation.decisionRole,
      detectorVersion: observation.detectorVersion,
      ruleId: observation.ruleId,
      ruleVersion: observation.ruleVersion,
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
  readonly context: Omit<GuardRequest['context'], 'requestId' | 'direction' | 'policyBundleId'> &
    Partial<Pick<GuardRequest['context'], 'direction'>>;
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
    artifactId: input.contextArtifactId, artifactSha256: input.contextArtifactId && input.userText ? createHash('sha256').update(input.userText).digest('hex') : undefined,
  }] : [];
  const ocrSegments: InputSegment[] = input.ocr.map((region) => ({
    text: region.text,
    source: 'image_ocr',
    artifactId: region.artifactId,
    artifactSha256: region.artifactSha256,
    viewId: region.viewId,
    region: region.region,
    page: region.page,
  }));
  const codeSegments: InputSegment[] = (input.codes ?? []).map((region) => ({
    text: region.text,
    source: 'qr_code',
    artifactId: region.artifactId,
    artifactSha256: region.artifactSha256,
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
    ACTION_PRIORITY[userDecision.action],
    ACTION_PRIORITY[imageDecision.action],
    ACTION_PRIORITY[codeDecision.action],
  );
  const populatedModalities = [user.text, image.text, codes.text].filter(Boolean).length;
  const cooperativeAttack = populatedModalities >= 2 &&
    ACTION_PRIORITY[combinedDecision.action] > strongestIndividual;
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
  const coverage=assessAnalysisCoverage({coverage:input.analysisCoverage,artifactSha256:input.artifactSha256,...input.context,requiredRiskIds:input.bundle.payload.semanticCoverage?.requiredRiskIds??[],combination:input.userText ? 'TEXT+' + (input.analysisCoverage?.modality ?? 'IMAGE') : input.analysisCoverage?.modality});
  const coverageAction:GuardAction=input.bundle.payload.semanticDecisionMode==='coverage-v1'&&!coverage.complete?'REQUIRE_REVIEW':'ALLOW';
  const individual = [
    ...(user.text ? [userDecision.action] : []),
    ...(image.text ? [imageDecision.action] : []),
    ...(codes.text ? [codeDecision.action] : []),
  ];
  const { action } = combineActionConstraints([
    ...individual, combinedDecision.action, visualAction, failureAction, trustAction, coverageAction,
  ]);
  const visualEvidence = input.visual.map((item) => {
    const position = validateEvidenceLocation({ artifactId: item.artifactId, sourceDigest: item.artifactSha256, contentVersion: item.artifactSha256,
      contentPath: `/views/${item.viewId}`, mappingVersion: 'guard-evidence-location-1', offsetEncoding: 'UTF16', viewId: item.viewId, region: item.region });
    const base = {
      locations: position.location ? [position.location] : [], locationState: position.state,
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
  // Map each branch against its own offsets before deduplicating the same finding.
  const textEvidence = [
    ...mappedEvidence(userDecision, user.spans, input.context.traceId),
    ...mappedEvidence(imageDecision, image.spans, input.context.traceId),
    ...mappedEvidence(codeDecision, codes.spans, input.context.traceId),
    ...mappedEvidence(combinedDecision, combined.spans, input.context.traceId),
  ];
  return {
    privateEvidenceViews: [...userSegments,...ocrSegments,...codeSegments].flatMap(segment=>segment.artifactId&&segment.artifactSha256?[makeEvidenceView({artifactId:segment.artifactId,sourceDigest:segment.artifactSha256,text:segment.text,source:segment.source,
      contentPath:'/views/'+encodeURIComponent(segment.viewId??'original'),viewId:segment.viewId,page:segment.page,region:segment.region})]:[]),
    action,
    coverage,
    cooperativeAttack,
    degraded: failures.length > 0 || (input.bundle.payload.semanticDecisionMode === 'coverage-v1' && !coverage.complete),
    textDecisions: {
      user: userDecision,
      image: imageDecision,
      codes: codeDecision,
      combined: combinedDecision,
    },
    evidence: [
      ...new Map(textEvidence.map((item) => [item.evidenceRef, item])).values(),
      ...visualEvidence,
      ...failureEvidence,
    ],
  };
}
