import { z } from 'zod';
import type { Direction, GuardAction } from '@guardllm/contracts';
import { analysisCoverageSchema, type AnalysisCoverage } from '@/contracts/http/multimodal-analysis';
export { analysisCoverageSchema, type AnalysisCoverage } from '@/contracts/http/multimodal-analysis';

const approvals = z.array(z.object({
  tenantId: z.string(), applicationId: z.string(), analyzerVersion: z.string(),
  modality: z.enum(['IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO']), riskIds: z.array(z.string()).min(1), validUntil: z.iso.datetime(),
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/u), approvalRef: z.string().min(1), gateStatus: z.literal('PASS'),
  directions: z.array(z.string()).min(1).optional(), combinations: z.array(z.string()).min(1).optional(),
}).strict());

export function assessAnalysisCoverage(input: {
  coverage?: AnalysisCoverage; artifactSha256?: string; tenantId: string; applicationId: string;
  requiredRiskIds: readonly string[]; direction?: Direction; combination?: string;
}, raw = process.env.MULTIMODAL_QUALITY_APPROVALS_JSON) {
  const parsed = analysisCoverageSchema.safeParse(input.coverage);
  const bound = parsed.success && Boolean(input.artifactSha256) && parsed.data.artifactSha256 === input.artifactSha256;
  const processingComplete = bound && parsed.data.state === 'COMPLETE' && parsed.data.processedUnits === parsed.data.expectedUnits && parsed.data.reasonCodes.length === 0 &&
    (parsed.data.processingCoverage ?? []).every(unit => unit.processed === unit.expected && unit.failed === 0 && unit.skipped === 0);
  let registry: z.infer<typeof approvals> = [];
  try { registry = approvals.parse(JSON.parse(raw ?? '[]')); } catch { /* Invalid approvals remain unqualified. */ }
  const qualified = bound ? registry.find(value => value.tenantId === input.tenantId && value.applicationId === input.applicationId &&
    value.analyzerVersion === parsed.data.analyzerVersion && value.modality === parsed.data.modality && Date.parse(value.validUntil) > Date.now() &&
    (value.directions ?? ['INPUT']).includes(input.direction ?? 'INPUT') &&
    (!input.combination || input.combination === parsed.data.modality || Boolean(value.combinations?.includes(input.combination))) &&
    input.requiredRiskIds.length > 0 && input.requiredRiskIds.every(risk => value.riskIds.includes(risk))) : undefined;
  const complete = processingComplete && Boolean(qualified);
  const reasonCode = !bound ? 'MODALITY_COVERAGE_UNVERIFIED' : !processingComplete ? 'MODALITY_ANALYSIS_INCOMPLETE' :
    !qualified ? 'MODALITY_QUALITY_UNVERIFIED' : 'MODALITY_QUALIFIED_COMPLETE';
  return {
    complete, reasonCode, processingComplete, semanticQualified: Boolean(qualified), semanticComplete: complete,
    requiredRiskIds: [...input.requiredRiskIds], direction: input.direction ?? 'INPUT',
    combination: input.combination ?? (parsed.success ? parsed.data.modality : 'UNKNOWN'),
    qualification: qualified ? { approvalRef: qualified.approvalRef, datasetSha256: qualified.datasetSha256, validUntil: qualified.validUntil, analyzerVersion: qualified.analyzerVersion } : null,
  };
}

/** Durable result metadata shared by both workers; never promotes sampled coverage to complete. */
export function coverageResult(input: {
  analysisCoverage?: AnalysisCoverage; fusionCoverage: ReturnType<typeof assessAnalysisCoverage>;
  action: GuardAction; failures: readonly { code: string }[]; strict: boolean; windowReasons?: readonly string[];
}) {
  const reasons = [...new Set([...input.failures.map(item => item.code), ...(input.windowReasons ?? []),
    ...(!input.fusionCoverage.complete ? [input.fusionCoverage.reasonCode] : [])])];
  return {
    analysisContractVersion: '1.1' as const,
    analysisCoverage: input.analysisCoverage ?? null,
    fusionCoverage: input.fusionCoverage,
    releaseEligibility: {
      eligible: input.fusionCoverage.complete && reasons.length === 0 && ['ALLOW', 'WARN'].includes(input.action),
      reasonCodes: [...reasons, ...(!['ALLOW', 'WARN'].includes(input.action) ? ['ACTION_REQUIRES_INTERVENTION'] : [])],
      executionPermitRequired: true,
    },
    degradationReasons: reasons,
    degraded: input.failures.length > 0 || Boolean(input.windowReasons?.length) || (input.strict && !input.fusionCoverage.complete),
  };
}
