import { z } from 'zod';

const boundedId = z.string().min(1).max(128);

export const documentTaskParamsSchema = z.object({ id: boundedId });
export const documentFindingParamsSchema = z.object({
  id: boundedId,
  findingId: boundedId,
});
export const documentTaskQuerySchema = z
  .object({
    policyId: boundedId.optional(),
    status: z.enum(['pending', 'parsing', 'detecting', 'completed', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
export const updateDocumentFindingSchema = z
  .object({
    status: z.enum(['open', 'accepted', 'ignored']),
    ignoreReason: z
      .enum(['false_positive', 'test_data', 'education', 'acceptable', 'other'])
      .optional(),
    ignoreNote: z.string().max(2_000).optional(),
  })
  .strict()
  .refine((value) => value.status !== 'ignored' || Boolean(value.ignoreReason), {
    message: 'ignoreReason is required when a finding is ignored',
    path: ['ignoreReason'],
  });
export const documentUploadMetadataSchema = z
  .object({
    policyId: boundedId,
    ocrEnabled: z.boolean().default(false),
    ocrModel: boundedId.nullable().optional(),
  })
  .strict();
