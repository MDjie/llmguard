import { z } from 'zod';
import { nativeAssessmentSchema, nativeBindingSchema, nativeQualificationSchema, type NativeBinding } from '@/contracts/http/native-multimodal';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
export function nativeBindingDigest(binding: NativeBinding) { return sha256(canonicalJson(nativeBindingSchema.parse(binding))); }
export function nativeCombination(binding: NativeBinding) { return [...new Set(binding.sources.map(item => item.modality))].sort().join('+'); }
/** A server-side quality record is required in addition to a model verdict. No caller assertion grants a send permit. */
export function evaluateNativeAssessment(binding: NativeBinding, raw: unknown, heuristicSuspected = false, registry = process.env.NATIVE_MULTIMODAL_QUALIFICATIONS_JSON, now = Date.now()) {
  const expected = nativeBindingSchema.parse(binding), assessment = nativeAssessmentSchema.safeParse(raw);
  const unknown = (reason: string) => ({ verdict: heuristicSuspected ? 'SUSPECTED' as const : 'UNKNOWN' as const, qualified: false, eligible: false,
    reasonCodes: [reason], action: 'REQUIRE_REVIEW' as const, relations: [], qualification: null });
  if (!assessment.success) return unknown('NATIVE_ASSESSMENT_UNAVAILABLE');
  const value = assessment.data, sourceIds = new Set(expected.sources.map(source => source.sourceId));
  if (value.bindingDigest !== nativeBindingDigest(expected) || value.analyzedSourceIds.length !== sourceIds.size || new Set(value.analyzedSourceIds).size !== sourceIds.size || value.analyzedSourceIds.some(id => !sourceIds.has(id))) return unknown('NATIVE_SOURCE_BINDING_MISMATCH');
  if (value.riskIds.some(risk => !expected.requiredRiskIds.includes(risk)) || new Set(value.riskIds).size !== value.riskIds.length) return unknown('NATIVE_RISK_BINDING_MISMATCH');
  if (new Set(value.relations.map(relation => relation.relationId)).size !== value.relations.length) return unknown('NATIVE_RELATION_DUPLICATE');
  for (const relation of value.relations) {
    const ids = [...relation.sourceEvidenceIds, ...relation.targetEvidenceIds];
    if (ids.some(id => !sourceIds.has(id)) || new Set(ids).size !== ids.length || !value.riskIds.includes(relation.riskId)) return unknown('NATIVE_RELATION_SOURCE_INVALID');
  }
  if ((value.verdict === 'CONFIRMED' && (!value.riskIds.length || (sourceIds.size > 1 && !value.relations.some(relation => relation.verdict === 'CONFIRMED')))) ||
    (value.verdict === 'NOT_DETECTED' && (value.riskIds.length || value.relations.length))) return unknown('NATIVE_VERDICT_INCONSISTENT');
  let approvals: z.infer<typeof nativeQualificationSchema>[];
  try { approvals = z.array(nativeQualificationSchema).max(10000).parse(JSON.parse(registry ?? '[]')); } catch { return unknown('NATIVE_QUALIFICATION_INVALID'); }
  const qualification = approvals.find(item => item.tenantId === expected.tenantId && item.applicationId === expected.applicationId && item.bundleDigest === expected.bundleDigest &&
    item.modelId === value.modelId && item.modelDigest === value.modelDigest && item.analyzerVersion === value.analyzerVersion && item.direction === expected.direction &&
    item.combination === nativeCombination(expected) && item.coverageScope === value.coverageScope && Date.parse(item.validUntil) > now && expected.requiredRiskIds.every(risk => item.requiredRiskIds.includes(risk)));
  if (!qualification) return unknown('NATIVE_QUALITY_UNVERIFIED');
  const complete = value.processingComplete && value.coverageScope === 'GLOBAL' && value.reasonCodes.length === 0;
  return { verdict: value.verdict, qualified: true, eligible: complete && value.verdict === 'NOT_DETECTED',
    action: value.verdict === 'CONFIRMED' ? 'BLOCK' as const : complete && value.verdict === 'NOT_DETECTED' ? 'ALLOW' as const : 'REQUIRE_REVIEW' as const,
    reasonCodes: [...value.reasonCodes, ...(!complete ? ['NATIVE_COVERAGE_INCOMPLETE'] : []), ...(value.verdict === 'UNKNOWN' ? ['NATIVE_VERDICT_UNKNOWN'] : [])],
    relations: value.relations, qualification: { approvalRef: qualification.approvalRef, datasetDigest: qualification.datasetDigest, validUntil: qualification.validUntil, modelId: qualification.modelId, modelDigest: qualification.modelDigest } };
}
