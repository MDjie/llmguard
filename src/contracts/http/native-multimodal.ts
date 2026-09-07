import { z } from 'zod';
const id = z.string().min(1).max(128), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeSourceSchema = z.object({ sourceId: id, artifactId: id, sha256: digest, modality: z.enum(['TEXT','IMAGE','DOCUMENT','AUDIO','VIDEO']), contentVersion: id }).strict();
export const nativeBindingSchema = z.object({ version: z.literal('1.0'), tenantId: id, applicationId: id, bundleDigest: digest,
  direction: z.enum(['INPUT','OUTPUT_COMPLETE','OUTPUT_CHUNK','TOOL_RESULT']), contextDigest: digest,
  sources: z.array(nativeSourceSchema).min(1).max(9), requiredRiskIds: z.array(id).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.sources.map(item => item.sourceId)).size !== value.sources.length || new Set(value.sources.map(item => item.artifactId)).size !== value.sources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate native source' });
  if (new Set(value.requiredRiskIds).size !== value.requiredRiskIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate native risk' });
});
export const crossModalRelationSchema = z.object({ relationId: id, sourceEvidenceIds: z.array(id).min(1).max(8), targetEvidenceIds: z.array(id).min(1).max(8),
  relationType: z.enum(['instruction_target','cross_modal_completion','audio_visual_conflict','cross_turn_reference']),
  riskId: id, verdict: z.enum(['CONFIRMED','SUSPECTED']), explanation: z.string().min(1).max(512),
}).strict();
export const nativeAssessmentSchema = z.object({ version: z.literal('1.0'), bindingDigest: digest, modelId: id, modelDigest: digest, analyzerVersion: id,
  verdict: z.enum(['CONFIRMED','SUSPECTED','NOT_DETECTED','UNKNOWN']), riskIds: z.array(id).max(100),
  analyzedSourceIds: z.array(id).min(1).max(9), coverageScope: z.enum(['GLOBAL','WINDOW']), processingComplete: z.boolean(),
  relations: z.array(crossModalRelationSchema).max(100), reasonCodes: z.array(id).max(100),
}).strict();
export const nativeQualificationSchema = z.object({ tenantId: id, applicationId: id, modelId: id, modelDigest: digest, analyzerVersion: id, bundleDigest: digest,
  direction: nativeBindingSchema.shape.direction, combination: id, requiredRiskIds: z.array(id).min(1).max(100),
  coverageScope: z.literal('GLOBAL'), datasetDigest: digest, approvalRef: id, validUntil: z.iso.datetime(), status: z.literal('PASS'),
}).strict();
export type NativeBinding = z.infer<typeof nativeBindingSchema>;
export type NativeAssessment = z.infer<typeof nativeAssessmentSchema>;
