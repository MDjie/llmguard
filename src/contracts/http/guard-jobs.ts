import { z } from 'zod';

const id = z.string().min(1).max(128);

export const createGuardJobSchema = z.object({
  artifactId: id,
  contextArtifactId: id.optional(),
  bundleId: id,
  jobType: z.enum([
    'auto', 'document_image', 'audio_video', 'rag_ingest', 'tool_result', 'content_mark', 'code_scan',
  ]).default('auto'),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  callback: z.object({
    url: z.string().url().max(1_000),
    secretRef: z.string().min(1).max(100),
  }).strict().optional(),
}).strict();

export const guardJobParamsSchema = z.object({ id }).strict();
export const guardJobListQuerySchema = z.object({
  status: z.enum(['pending', 'running', 'retrying', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
