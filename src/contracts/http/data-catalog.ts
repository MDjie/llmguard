import { z } from 'zod';

export const dataCategorySchema = z.enum(['CUSTOMER', 'POLICY', 'HEALTH', 'PROPERTY', 'MODEL', 'PROMPT', 'LOG', 'SECRET', 'OTHER']);
export const classificationLevelSchema = z.enum(['PUBLIC', 'INTERNAL', 'SENSITIVE', 'HIGHLY_SENSITIVE']);
export const classificationControlsSchema = z.object({
  tlsRequired: z.boolean(), accessControlled: z.boolean(), encryptionAtRest: z.boolean(),
  maskingRequired: z.boolean(), accessAudited: z.boolean(), externalTransferProhibited: z.boolean(),
  dualApprovalRequired: z.boolean(), tokenizationRequired: z.boolean(),
}).strict();

export const createCatalogEntrySchema = z.object({
  assetCode: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/),
  name: z.string().trim().min(1).max(200), category: dataCategorySchema,
  classificationLevel: classificationLevelSchema, ownerId: z.string().trim().min(1).max(100),
  stewardId: z.string().trim().min(1).max(100).optional(), retentionDays: z.number().int().min(1).max(3650),
  sourceSystem: z.string().trim().min(1).max(200), storageLocation: z.string().trim().min(1).max(500),
  legalBasis: z.string().trim().min(1).max(500).optional(), controlPolicy: classificationControlsSchema,
}).strict();

export const catalogListQuerySchema = z.object({
  category: dataCategorySchema.optional(), classificationLevel: classificationLevelSchema.optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(20),
}).strict();
export const catalogParamsSchema = z.object({ id: z.uuid() }).strict();
export const updateCatalogEntrySchema = z.object({
  expectedVersion: z.number().int().positive(), classificationLevel: classificationLevelSchema,
  ownerId: z.string().trim().min(1).max(100), stewardId: z.string().trim().min(1).max(100).optional(),
  retentionDays: z.number().int().min(1).max(3650), legalBasis: z.string().trim().min(1).max(500).optional(),
  controlPolicy: classificationControlsSchema, status: z.enum(['ACTIVE', 'ARCHIVED']),
}).strict();
export const catalogResponseSchema = z.object({}).loose();
