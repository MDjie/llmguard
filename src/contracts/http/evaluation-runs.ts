import { z } from 'zod';

const boundedId = z.string().min(1).max(128);

export const submitEvaluationRunSchema = z.object({
  bundleId: boundedId,
  testCaseIds: z.array(boundedId).min(1).max(10_000),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  maxAttempts: z.number().int().min(1).max(10).default(3),
}).strict();

export const listEvaluationRunsSchema = z.object({
  status: z.enum(['pending', 'running', 'retrying', 'completed', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const evaluationRunParamsSchema = z.object({
  id: boundedId,
}).strict();
