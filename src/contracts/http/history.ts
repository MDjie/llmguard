import { z } from 'zod';

const boundedId = z.string().min(1).max(128);
const riskAction = z.enum(['allow', 'warn', 'block', 'mask', 'rewrite']);
const findingSchema = z
  .object({
    dimension: z.string().min(1).max(64),
    dimensionName: z.string().max(128).optional(),
    score: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1).optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    matchedRules: z.array(z.string().max(128)).max(100).optional(),
    evidence: z.array(z.string().max(512)).max(50).optional(),
    reason: z.string().max(2_000).optional(),
    action: riskAction.optional(),
  })
  .strict();

const detectionSchema = z
  .object({
    action: riskAction,
    processingAction: z.enum(['none', 'mask', 'rewrite']).optional(),
    overallScore: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1).optional(),
    findings: z.array(findingSchema).max(100),
    summary: z.string().max(2_000).optional(),
    latencyMs: z.number().int().min(0).max(600_000).optional(),
    whitelistMatched: z.record(z.string(), z.unknown()).optional(),
    skippedDimensions: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  })
  .strict();

export const recordDetectionSessionSchema = z
  .object({
    userPrompt: z.string().min(1).max(32_768),
    mockModelOutput: z.string().max(32_768).optional(),
    finalResponse: z.string().max(32_768).optional(),
    inputDetection: detectionSchema.optional(),
    outputDetection: detectionSchema.optional(),
    policyId: boundedId.optional(),
    targetProviderId: boundedId.optional(),
    judgeProviderId: boundedId.optional(),
    userId: z.string().max(128).optional(),
  })
  .strict();

export const historyQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    action: z.union([z.literal('all'), riskAction]).optional(),
    search: z.string().max(256).optional(),
    dimension: z.string().min(1).max(64).optional(),
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
  })
  .strict();

export const historyDeleteQuerySchema = z.object({ id: boundedId }).strict();

export const exportHistoryQuerySchema = z
  .object({
    format: z.enum(['json', 'csv', 'markdown']).default('json'),
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
    riskType: z.string().min(1).max(64).optional(),
    action: riskAction.optional(),
  })
  .strict();

export const requestExportApprovalSchema = z.object({
  purpose: z.string().trim().min(10).max(500),
  exportQuery: exportHistoryQuerySchema,
}).strict();

export const decideExportApprovalSchema = z.object({
  id: z.uuid(),
  decision: z.enum(['approved', 'rejected']),
}).strict();

export const exportApprovalListQuerySchema = z.object({
  mine: z.enum(['true', 'false']).default('false'),
  status: z.enum(['pending', 'approved', 'rejected', 'consumed']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export type ExportHistoryQuery = z.infer<typeof exportHistoryQuerySchema>;
export type ExportDateRange = '7d' | '30d' | '90d' | 'all';
/** Calendar days in UTC, inclusive today; shared by stats, approvals and export. */
export function exportDateRange(range: ExportDateRange, now = new Date()): Pick<ExportHistoryQuery, 'startDate' | 'endDate'> {
  if (range === 'all') return {};
  const endDate = now.toISOString().slice(0, 10);
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - Number(range.slice(0, -1)) + 1);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}
export const exportStatsQuerySchema = exportHistoryQuerySchema.omit({ format: true }).extend({ days: z.coerce.number().int().min(0).max(3650).optional() }).strict();
export const exportStatsResponseSchema = z.object({ success: z.literal(true), data: z.object({ totalRecords: z.number().int().nonnegative(), exportLimit: z.number().int().positive(), dateRange: z.string() }) });
