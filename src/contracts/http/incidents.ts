import { z } from 'zod';

export const incidentStatusSchema = z.enum(['PENDING_REVIEW', 'IN_PROGRESS', 'FALSE_POSITIVE', 'BLOCKED', 'REMEDIATED', 'CLOSED']);
export const incidentSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const createIncidentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  severity: incidentSeveritySchema,
  traceId: z.string().trim().min(1).max(128).optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),
  riskType: z.string().trim().min(1).max(128),
  eventAnalysis: z.string().trim().min(1).max(4_000),
  attackTechnique: z.string().trim().min(1).max(4_000),
  impact: z.string().trim().min(1).max(4_000),
  answerEvidence: z.string().trim().min(1).max(4_000),
  assigneeId: z.string().trim().min(1).max(100).optional(),
  slaMinutes: z.number().int().min(5).max(90 * 24 * 60),
}).strict();

export const incidentListQuerySchema = z.object({
  status: incidentStatusSchema.optional(),
  severity: incidentSeveritySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
}).strict();

export const incidentParamsSchema = z.object({ id: z.uuid() }).strict();

export const transitionIncidentSchema = z.object({
  expectedVersion: z.number().int().positive(),
  toStatus: incidentStatusSchema,
  assigneeId: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().min(1).max(4_000).optional(),
}).strict();

export const incidentResponseSchema = z.object({}).loose();
