import { z } from 'zod';
import { evidenceLocationSchema } from './multimodal-analysis';
const id = z.string().min(1).max(128);
export const alertActionSchema = z.enum(['ALLOW', 'WARN', 'BLOCK', 'MASK', 'REWRITE', 'SAFE_RESPONSE', 'REQUIRE_REVIEW']);
export const alertEvidenceSchema = z.object({
  evidenceId: id, ruleId: id.optional(), ruleVersion: id.optional(), detectorId: id.optional(),
  contentHmac: z.string().max(128).optional(), maskedPreview: z.string().max(512).optional(),
  locations: z.array(evidenceLocationSchema).max(1000).default([]),
  locationState: z.enum(['VERIFIED', 'UNVERIFIED']).default('UNVERIFIED'),
}).strict();
export const alertFindingSchema = z.object({
  riskId: id, score: z.number().min(0).max(1), reasonCode: id,
  category: z.enum(['SECURITY_RISK', 'UNDETERMINED', 'SYSTEM_FAILURE']),
  evidence: z.array(alertEvidenceSchema).max(1000),
}).strict();
export const decisionRecordedSchema = z.object({
  version: z.literal('1.0'), source: z.enum(['GATEWAY', 'GUARD_JOB', 'LEGACY']),
  sourceId: id, requestId: id.optional(), jobId: id.optional(), traceId: id, sessionId: id.optional(),
  decisionId: id, bundleId: id.optional(), stage: id, action: alertActionSchema,
  occurredAt: z.iso.datetime(), coverage: z.record(z.string(), z.unknown()).default({}),
  findings: z.array(alertFindingSchema).max(1000),
}).strict();
export type DecisionRecorded = z.infer<typeof decisionRecordedSchema>;
export const alertQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).optional(), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  action: alertActionSchema.optional(), category: z.enum(['SECURITY_RISK', 'UNDETERMINED', 'SYSTEM_FAILURE']).optional(),
  riskId: id.optional(), requestId: id.optional(), sessionId: id.optional(), stage: id.optional(),
}).strict();
export type AlertQuery = z.infer<typeof alertQuerySchema>;
export const alertViewSchema = z.object({
  id, source: id, sourceId: id, requestId: id.nullable(), jobId: id.nullable(), traceId: id, sessionId: id.nullable(),
  decisionId: id, bundleId: id.nullable(), riskId: id, category: id, stage: id, action: alertActionSchema,
  reasonCodes: z.array(z.string()).default([]), score: z.number(), occurredAt: z.iso.datetime(), createdAt: z.iso.datetime(),
  evidence: z.array(alertEvidenceSchema), coverage: z.record(z.string(), z.unknown()),
  actualOutcome: z.string().nullable(), incidentId: z.string().nullable(),
}).strict();
export const alertListSchema = z.object({ items: z.array(alertViewSchema), nextCursor: z.string().nullable(), hasMore: z.boolean(), watermark: z.iso.datetime(), from: z.iso.datetime(), to: z.iso.datetime() }).strict();
export type AlertView = z.infer<typeof alertViewSchema>;
export type AlertList = z.infer<typeof alertListSchema>;
