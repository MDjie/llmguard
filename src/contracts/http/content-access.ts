import { z } from 'zod';

export const contentAccessPurposeSchema = z.enum([
  'INCIDENT_INVESTIGATION',
  'REGULATORY_REVIEW',
  'FALSE_POSITIVE_APPEAL',
]);

export const createContentAccessRequestSchema = z.object({
  purpose: contentAccessPurposeSchema,
  reason: z.string().trim().min(10).max(500),
}).strict();

export const listContentAccessRequestsSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const contentAccessRequestParamsSchema = z.object({ id: z.uuid() }).strict();

export const reviewContentAccessRequestSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const consumeContentAccessRequestSchema = z.object({
  requestId: z.uuid(),
}).strict();

const contentAccessStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const contentAccessRequestDataSchema = z.object({
  id: z.uuid(),
  resourceType: z.literal('INCIDENT_EVIDENCE'),
  resourceId: z.string().min(1).max(128),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  requesterId: z.string().min(1).max(100),
  purpose: contentAccessPurposeSchema,
  reason: z.string().max(500),
  status: contentAccessStatusSchema,
  reviewedBy: z.string().min(1).max(100).nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  decisionReason: z.string().max(500).nullable(),
  expiresAt: z.iso.datetime().nullable(),
  usedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
}).strict();

export const contentAccessRequestResponseSchema = z.object({
  success: z.literal(true),
  data: contentAccessRequestDataSchema,
}).strict();

export const contentAccessOwnListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(contentAccessRequestDataSchema).max(20),
}).strict();

export const contentAccessReviewListResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(contentAccessRequestDataSchema).max(100),
    total: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const contentAccessConsumeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    incidentId: z.string().min(1).max(128),
    accessRequestId: z.uuid(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    expiresAt: z.iso.datetime(),
    consumedAt: z.iso.datetime(),
    answerEvidence: z.string(),
  }).strict(),
}).strict();
