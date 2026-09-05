import { z } from 'zod';
import { guardRequestSchema } from './guard-v1';

const identifier = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const boundedText = z.string().trim().min(1).max(4_096);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const dictionaryLayerSchema = z.enum([
  'PLATFORM_REDLINE',
  'INDUSTRY',
  'TENANT',
  'APPLICATION',
  'INCIDENT',
]);

export const dictionaryEntrySchema = z.object({
  canonicalTermId: identifier.optional(),
  sourceIds: z.array(identifier).min(1).max(32).optional(),
  actionHint: identifier.optional(),
  sourceMatchMode: identifier.optional(),
  contextCases: z.array(z.object({caseId:identifier,text:boundedText,expectedRiskIds:z.array(identifier).max(100),acceptableActions:z.array(z.enum(['ALLOW','WARN','MASK','REWRITE','REQUIRE_REVIEW','SAFE_RESPONSE','BLOCK'])).min(1)}).strict()).max(100).optional(),
  canonicalTerm: z.string().trim().min(1).max(500),
  variants: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
  riskType: identifier,
  matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']).default('contains'),
  caseSensitive: z.boolean().default(false),
  score: z.number().min(0).max(1).default(0.9),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
  mandatoryDeny: z.boolean().default(false),
  locale: identifier.default('und'),
  direction: z.enum([
    'BOTH', 'INPUT', 'OUTPUT_COMPLETE', 'OUTPUT_CHUNK', 'RAG_INGEST',
    'RAG_CONTEXT', 'TOOL_REQUEST', 'TOOL_RESULT',
  ]).default('BOTH'),
  industry: identifier.default('general'),
  contexts: z.array(identifier).max(32).default([]),
  owner: z.string().trim().min(1).max(100),
  evidenceRequirement: z.string().trim().min(1).max(500),
  positiveExamples: z.array(z.string().trim().min(1).max(4_096)).min(1).max(100),
  negativeExamples: z.array(z.string().trim().min(1).max(4_096)).min(1).max(100),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.validFrom && value.validTo && Date.parse(value.validTo) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: 'custom', message: 'validTo must be later than validFrom', path: ['validTo'] });
  }
});

export const dictionaryManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  policyId: z.string().min(1).max(36),
  dictionaryId: identifier,
  version: identifier,
  layer: dictionaryLayerSchema,
  entries: z.array(dictionaryEntrySchema).min(1).max(500),
}).strict();

export const createDictionaryDraftSchema = dictionaryManifestSchema.omit({ schemaVersion: true });
export const governanceIdParamsSchema = z.object({ id: z.uuid() }).strict();
export const listDictionaryReleasesSchema = z.object({
  state: z.enum(['draft', 'reviewed', 'shadow', 'canary', 'active', 'deprecated', 'rolled_back']).optional(),
  dictionaryId: identifier.optional(),
}).strict();
export const dictionaryReasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const publishDictionarySchema = z.object({
  mode: z.enum(['SHADOW', 'CANARY']).default('SHADOW'),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export const createResponseTemplateSchema = z.object({
  templateKey: identifier,
  riskCategory: z.union([identifier, z.literal('*')]),
  action: z.enum(['WARN', 'MASK', 'REWRITE', 'REQUIRE_REVIEW', 'SAFE_RESPONSE', 'BLOCK']),
  locale: identifier.default('zh-CN'),
  industry: identifier.default('general'),
  jurisdiction: identifier.default('global'),
  businessLine: identifier.default('general'),
  legalDisclaimerVersion: identifier.default('none'),
  templateScope: z.enum(['PLATFORM', 'TENANT']).default('TENANT'),
  templateText: boundedText,
  allowedVariables: z.array(identifier).max(32).default([]),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.validFrom && value.validTo && Date.parse(value.validTo) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: 'custom', message: 'validTo must be later than validFrom', path: ['validTo'] });
  }
});

export const listResponseTemplatesSchema = z.object({
  approvalStatus: z.enum(['pending', 'approved', 'rejected', 'retired']).optional(),
  templateKey: identifier.optional(),
}).strict();
export const previewResponseTemplateSchema = z.object({
  templateId: z.uuid(),
  variables: z.record(identifier, z.string().max(512)).default({}),
}).strict();
export const reviewResponseTemplateSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

export const releaseHealthSchema = z.object({
  bundleId: z.string().min(1).max(36),
  expectedGeneration: z.number().int().nonnegative(),
  sampleSize: z.number().int().nonnegative(),
  minimumSampleSize: z.number().int().positive().max(10_000_000),
  errorBudgetHealthy: z.boolean(),
  errorRate: z.number().min(0).max(1),
  maximumErrorRate: z.number().min(0).max(1),
  p95LatencyMs: z.number().nonnegative(),
  maximumP95LatencyMs: z.number().positive(),
  p99LatencyMs: z.number().nonnegative(),
  maximumP99LatencyMs: z.number().positive(),
  falsePositiveRate: z.number().min(0).max(1),
  maximumFalsePositiveRate: z.number().min(0).max(1),
  falseNegativeRate: z.number().min(0).max(1),
  maximumFalseNegativeRate: z.number().min(0).max(1),
  resourceRejectionRate: z.number().min(0).max(1),
  maximumResourceRejectionRate: z.number().min(0).max(1),
  requiredDetectorFailures: z.number().int().nonnegative(),
  auditDeliveryTerminalFailures: z.number().int().nonnegative(),
  promoteWhenHealthy: z.boolean().default(false),
}).strict();

export const shadowComparisonSchema = z.object({ request: guardRequestSchema }).strict();

export const digestSummarySchema = z.object({
  id: identifier,
  version: identifier,
  sha256,
}).strict();

export const governanceObjectResponseSchema = z.object({}).loose();
