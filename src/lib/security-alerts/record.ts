import { createHash } from 'node:crypto';
import type { ContentSegment } from '../../../packages/contracts/generated/typescript/gateway-v2';
import type { GuardDecision } from '@guardllm/contracts';
import { z } from 'zod';
import type { recordDetectionSessionSchema } from '@/contracts/http/history';
import { alertActionSchema, alertEvidenceSchema, decisionRecordedSchema, type DecisionRecorded } from '@/contracts/http/security-alerts';
import { nativeBindingSchema, nativeAssessmentSchema } from '@/contracts/http/native-multimodal';
import { nativeBindingDigest } from '@/lib/multimodal/native-gate';
import { evidenceLocationSchema } from '@/contracts/http/multimodal-analysis';
const preview = (value: string | undefined) => value === undefined ? undefined : Array.from(value).slice(0, 256).join('');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function recordIdentity(scope: { tenantId: string; applicationId: string }, record: DecisionRecorded) {
  return digest([scope.tenantId, scope.applicationId, record.source, record.sourceId, record.decisionId, record.stage]);
}
export function fromGuardDecision(input: { sourceId: string; requestId: string; sessionId?: string; stage: string; decision: GuardDecision; spans?: readonly { segment: ContentSegment; start: number; end: number }[] }): DecisionRecorded {
  const decision = input.decision;
  const locationsFor = (evidence: GuardDecision['observations'][number]['evidence'][number]) => {
    if (evidence.locations?.length) return evidence.locations;
    if (evidence.start === undefined || evidence.end === undefined) return [];
    const span = input.spans?.find(item => evidence.start! >= item.start && evidence.end! <= item.end);
    if (!span) return [];
    const location = evidenceLocationSchema.safeParse({ artifactId: input.requestId, sourceDigest: span.segment.sourceDigest, contentVersion: input.sourceId,
      contentPath: span.segment.contentPath, mappingVersion: 'guard-evidence-location-1', offsetEncoding: 'UTF16',
      textStart: evidence.start - span.start, textEnd: evidence.end - span.start, textLength: span.segment.text.length });
    return location.success ? [location.data] : [];
  };
  const findings: DecisionRecorded['findings'] = decision.observations.filter(observation => observation.status === 'MATCH' && observation.decisionRole !== 'CLEARED' &&
    (observation.decisionRole !== 'CANDIDATE' || (decision.action === 'REQUIRE_REVIEW' && !decision.observations.some(other => other.riskType === observation.riskType && other.decisionRole === 'CLEARED')))).map(observation => ({
      riskId: observation.riskType, score: observation.score, reasonCode: observation.reasonCode ?? 'DETECTION_MATCH',
      category: observation.decisionRole === 'CANDIDATE' || observation.decisionRole === 'UNKNOWN' ? 'UNDETERMINED' as const : 'SECURITY_RISK' as const,
      evidence: observation.evidence.map((evidence, index) => ({
        evidenceId: digest([decision.decisionId, observation.detectorId, observation.ruleId, index, evidence.contentHmac]),
        ruleId: observation.ruleId, ruleVersion: observation.ruleVersion, detectorId: observation.detectorId,
        contentHmac: evidence.contentHmac, maskedPreview: preview(evidence.maskedPreview),
        locations: [...locationsFor(evidence)].flatMap(location => { const parsed = evidenceLocationSchema.safeParse(location); return parsed.success ? [parsed.data] : []; }),
        locationState: locationsFor(evidence).length && locationsFor(evidence).every(location => evidenceLocationSchema.safeParse(location).success) ? 'VERIFIED' as const : 'UNVERIFIED' as const,
      })),
    }));
  if (decision.degraded || (decision.action !== 'ALLOW' && findings.length === 0)) findings.push({
    riskId: 'system.detection_incomplete', score: 0, reasonCode: decision.degradationReasons[0] ?? decision.reasonCodes?.[0] ?? 'DETECTION_INCOMPLETE',
    category: decision.degraded ? 'SYSTEM_FAILURE' : 'UNDETERMINED', evidence: [],
  });
  return decisionRecordedSchema.parse({ version: '1.0', source: 'GATEWAY', sourceId: input.sourceId, requestId: input.requestId, sessionId: input.sessionId, stage: input.stage,
    traceId: decision.traceId, decisionId: decision.decisionId, bundleId: decision.bundleId, action: decision.action, occurredAt: new Date().toISOString(),
    coverage: { evidenceComplete: decision.evidenceComplete ?? false, degraded: decision.degraded, reasonCodes: decision.degradationReasons }, findings,
  });
}

const jobEvidenceSchema = z.object({ riskType: z.string(), score: z.number(), reasonCode: z.string(), status: z.string().optional(), decisionRole: z.string().optional(), action: z.string().optional(), evidenceRef: z.string().optional(),
  ruleId: z.string().optional(), ruleVersion: z.string().optional(), detectorId: z.string().optional(), contentHmac: z.string().optional(), maskedPreview: z.string().optional(),
  locations: z.array(z.unknown()).optional(), locationState: z.string().optional(),
}).loose();
export function fromJobResult(job: { id: string; bundleId: string; jobType?: string }, result: Record<string, unknown>): DecisionRecorded | null {
  const action = alertActionSchema.safeParse(result.action); if (!action.success) return null;
  const findings: DecisionRecorded['findings'] = [];
  for (const raw of Array.isArray(result.evidence) ? result.evidence : []) {
    const parsed = jobEvidenceSchema.safeParse(raw); if (!parsed.success) continue;
    const value = parsed.data;
    if (value.decisionRole === 'CLEARED' || (value.status && value.status !== 'MATCH') || (value.action === 'ALLOW' && value.decisionRole !== 'CONFIRMED_RISK') || (value.decisionRole === 'CANDIDATE' && action.data !== 'REQUIRE_REVIEW')) continue;
    findings.push({ riskId: value.riskType, score: value.score, reasonCode: value.reasonCode,
      category: value.riskType.startsWith('system.') ? 'SYSTEM_FAILURE' : ['CANDIDATE','UNKNOWN'].includes(value.decisionRole ?? '') ? 'UNDETERMINED' : 'SECURITY_RISK',
      evidence: [alertEvidenceSchema.parse({ evidenceId: value.evidenceRef ?? digest(value), ruleId: value.ruleId, ruleVersion: value.ruleVersion,
        detectorId: value.detectorId, contentHmac: value.contentHmac, maskedPreview: preview(value.maskedPreview),
        locations: (value.locations ?? []).flatMap(location => { const parsed = evidenceLocationSchema.safeParse(location); return parsed.success ? [parsed.data] : []; }), locationState: value.locations?.length && value.locations.every(location => evidenceLocationSchema.safeParse(location).success) && value.locationState === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED' })],
    });
  }
  const nativeBinding = nativeBindingSchema.safeParse(result.nativeBinding), nativeAssessment = nativeAssessmentSchema.safeParse(result.nativeAssessment);
  if (nativeBinding.success && nativeAssessment.success && nativeAssessment.data.bindingDigest === nativeBindingDigest(nativeBinding.data)) {
    const assessment = nativeAssessment.data;
    if (['CONFIRMED', 'SUSPECTED'].includes(assessment.verdict)) for (const riskId of assessment.riskIds) findings.push({
      riskId, score: assessment.verdict === 'CONFIRMED' ? 1 : 0.5, reasonCode: 'NATIVE_CROSS_MODAL_' + assessment.verdict,
      category: assessment.verdict === 'CONFIRMED' && result.crossModalVerdict === 'CONFIRMED' ? 'SECURITY_RISK' : 'UNDETERMINED',
      evidence: [{ evidenceId: digest([job.id, riskId, assessment.bindingDigest]), detectorId: 'native-joint', ruleVersion: assessment.analyzerVersion,
        locations: [], locationState: 'UNVERIFIED' }],
    });
  }
  if (result.degraded === true || (action.data !== 'ALLOW' && !findings.length)) findings.push({ riskId: 'system.media_coverage_incomplete', score: 0,
    reasonCode: 'MEDIA_COVERAGE_INCOMPLETE', category: 'UNDETERMINED', evidence: [] });
  return decisionRecordedSchema.parse({ version: '1.0', source: 'GUARD_JOB', sourceId: job.id, jobId: job.id, traceId: `${job.jobType === 'audio_video' ? 'media' : 'job'}-trace-${job.id}`,
    decisionId: digest([job.id, result]), bundleId: job.bundleId, stage: nativeBinding.success ? nativeBinding.data.direction : 'INPUT', action: action.data, occurredAt: new Date().toISOString(),
    coverage: { analysisCoverage: result.analysisCoverage ?? null, fusionCoverage: result.fusionCoverage ?? null, nativeCoverage: result.nativeCoverage ?? null, relationSources: result.relationSources ?? [], relations: Array.isArray(result.relations) ? result.relations.map(value => { if (!value || typeof value !== 'object') return null; const { explanation: _explanation, ...relation } = value; void _explanation; return relation; }) : [], releaseEligibility: result.releaseEligibility ?? null }, findings });
}

export function groupAlertFindings(record: DecisionRecorded) {
  const groups = new Map<string, DecisionRecorded['findings'][number]>();
  for (const finding of record.findings) {
    const key = digest([finding.riskId, finding.category]); const previous = groups.get(key);
    groups.set(key, previous ? { ...previous, score: Math.max(previous.score, finding.score),
      evidence: [...new Map([...previous.evidence, ...finding.evidence].map(item => [item.evidenceId, item])).values()] } : finding);
  }
  return [...groups.entries()];
}

/** Legacy reports originate at the client and carry no server execution proof. */
export function fromLegacySession(sessionId: string, input: z.infer<typeof recordDetectionSessionSchema>): DecisionRecorded[] {
  return ([['INPUT', input.inputDetection], ['OUTPUT_COMPLETE', input.outputDetection]] as const).flatMap(([stage, detection]) => {
    if (!detection) return [];
    const findings: DecisionRecorded['findings'] = detection.findings.filter(finding => finding.score > 0).map(finding => ({
      riskId: finding.dimension, score: finding.score / 100, reasonCode: 'LEGACY_CLIENT_REPORTED', category: 'UNDETERMINED',
      evidence: (finding.matchedRules ?? []).map(ruleId => ({ evidenceId: digest([sessionId, stage, finding.dimension, ruleId]), ruleId,
        locations: [], locationState: 'UNVERIFIED' })),
    }));
    if (!findings.length && detection.action !== 'allow') findings.push({ riskId: 'legacy.unverified_decision', score: 0, reasonCode: 'LEGACY_CLIENT_REPORTED', category: 'UNDETERMINED', evidence: [] });
    return [decisionRecordedSchema.parse({ version: '1.0', source: 'LEGACY', sourceId: sessionId, sessionId, traceId: `legacy-${sessionId}`,
      decisionId: digest([sessionId, stage]), stage, action: detection.action.toUpperCase(), occurredAt: new Date().toISOString(),
      coverage: { provenance: 'CLIENT_REPORTED', executionVerified: false }, findings })];
  });
}

export function fromJobFailure(job: { id: string; bundleId: string; jobType: string }): DecisionRecorded {
  return decisionRecordedSchema.parse({ version: '1.0', source: 'GUARD_JOB', sourceId: job.id, jobId: job.id,
    traceId: `${job.jobType === 'audio_video' ? 'media' : 'job'}-trace-${job.id}`, decisionId: digest([job.id, 'TERMINAL_FAILURE']), bundleId: job.bundleId,
    stage: 'INPUT', action: 'REQUIRE_REVIEW', occurredAt: new Date().toISOString(), coverage: { processingComplete: false, semanticComplete: false },
    findings: [{ riskId: 'system.job_failed', score: 0, reasonCode: 'GRD_JOB_EXECUTION_FAILED', category: 'SYSTEM_FAILURE', evidence: [] }] });
}
