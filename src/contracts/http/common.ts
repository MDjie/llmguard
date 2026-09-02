import { z } from 'zod';

export const jsonObjectResponseSchema = z.record(z.string(), z.unknown());

export const emptyQuerySchema = z.object({}).strict();

export const idParamsSchema = z.object({
  id: z.string().min(1).max(128),
});

export const idOrCodeParamsSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});

export const dimensionRuleParamsSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  ruleId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});
