import { z } from 'zod';

const boundedId = z.string().min(1).max(128);
const riskAction = z.enum(['allow', 'warn', 'block', 'mask', 'rewrite']);
const dimensionCode = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);

const testCaseFields = {
  title: z.string().trim().min(1).max(256),
  description: z.string().max(4_000).default(''),
  category: z.string().trim().min(1).max(64).default('normal_qa'),
  inputText: z.string().min(1).max(32_768),
  outputText: z.string().max(32_768).nullable().optional(),
  expectedAction: riskAction.default('allow'),
  expectedDimensions: z.array(dimensionCode).max(100).default([]),
  expectedScoreMin: z.number().int().min(0).max(100).optional(),
  expectedScoreMax: z.number().int().min(0).max(100).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  enabled: z.boolean().default(true),
};

export const createTestCaseSchema = z
  .object(testCaseFields)
  .strict()
  .refine(
    (value) =>
      value.expectedScoreMin === undefined ||
      value.expectedScoreMax === undefined ||
      value.expectedScoreMin <= value.expectedScoreMax,
    {
      message: 'expectedScoreMin must not exceed expectedScoreMax',
      path: ['expectedScoreMin'],
    },
  );

export const updateTestCaseSchema = z
  .object({
    id: boundedId,
    ...Object.fromEntries(
      Object.entries(testCaseFields).map(([key, schema]) => [key, schema.optional()]),
    ),
  })
  .strict();

export const updateTestCaseByIdSchema = updateTestCaseSchema.omit({ id: true });
export const testCaseParamsSchema = z.object({ id: boundedId });
export const testCaseDeleteQuerySchema = z.object({ id: boundedId }).strict();
export const runTestCasesSchema = z
  .object({
    policyId: boundedId.optional(),
    testCaseIds: z.array(boundedId).min(1).max(200).optional(),
  })
  .strict();
