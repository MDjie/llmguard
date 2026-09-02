import { z } from 'zod';

export const auditOutcomeSchema = z.enum(['ALLOWED', 'DENIED', 'ERROR']);
export const auditEventsQuerySchema = z.object({
  eventPrefix: z.string().trim().min(1).max(160).optional(),
  outcome: auditOutcomeSchema.optional(),
  status: z.coerce.number().int().min(100).max(599).optional(),
  principalId: z.string().trim().min(1).max(100).optional(),
  traceId: z.string().trim().min(1).max(128).optional(),
  requestId: z.string().trim().min(1).max(128).optional(),
  pathPrefix: z.string().trim().min(1).max(500).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict().refine((query) => !query.from || !query.to || query.from <= query.to, {
  message: 'from must be earlier than or equal to to', path: ['from'],
});

export const auditReportQuerySchema = z.object({
  period: z.enum(['DAY', 'WEEK', 'MONTH', 'QUARTER']),
  anchor: z.iso.datetime().optional(),
}).strict();

export const auditApiResponseSchema = z.object({}).loose();
