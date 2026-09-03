import { z } from 'zod';

const boundedId = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const securityScanTargetSchema = z.object({
  type: z.enum(['REGISTERED_HOST', 'REGISTERED_WEB_APP', 'MODEL_ARTIFACT']),
  inventoryId: z.string().uuid(),
  version: z.string().min(1).max(256),
  sha256: digest.optional(),
}).strict();

export const registerSecurityScanAssetSchema = z.object({
  type: z.enum(['REGISTERED_HOST', 'REGISTERED_WEB_APP', 'MODEL_ARTIFACT']),
  externalInventoryId: boundedId,
  version: z.string().min(1).max(256),
  sha256: digest.optional(),
}).strict().superRefine((value, context) => {
  if (value.type === 'MODEL_ARTIFACT' && !value.sha256) {
    context.addIssue({ code: 'custom', message: 'Model assets require a sha256 digest' });
  }
});

export const listSecurityScanAssetsSchema = z.object({
  type: z.enum(['REGISTERED_HOST', 'REGISTERED_WEB_APP', 'MODEL_ARTIFACT']).optional(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const submitSecurityScanSchema = z.object({
  scannerId: boundedId,
  target: securityScanTargetSchema,
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  maxAttempts: z.number().int().min(1).max(10).default(3),
}).strict();

export const listSecurityScansSchema = z.object({
  status: z.enum(['QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const securityScanParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

export const reviewSecurityFindingSchema = z.object({
  disposition: z.enum([
    'CONFIRMED',
    'FALSE_POSITIVE',
    'DISPUTED',
    'ARBITRATED_CONFIRMED',
    'ARBITRATED_FALSE_POSITIVE',
  ]),
  reason: z.string().trim().min(3).max(1_000),
}).strict();
