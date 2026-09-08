import { z } from 'zod';
export const whitelistDirections = ['INPUT', 'OUTPUT_COMPLETE', 'OUTPUT_CHUNK', 'RAG_INGEST', 'RAG_CONTEXT', 'TOOL_REQUEST', 'TOOL_RESULT'] as const;
const whitelistRuleFields = {
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).optional(),
  policyScope: z.enum(['all', 'specific']),
  policyIds: z.array(z.string().min(1).max(36)).max(100).default([]),
  dimensionScope: z.enum(['all', 'specific']),
  dimensionCodes: z
    .array(z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/))
    .max(100)
    .default([]),
  targetRuleIds: z
    .array(z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/))
    .min(1)
    .max(5_000)
    .default([]),
  directions: z
    .array(z.enum([
      'INPUT',
      'OUTPUT_COMPLETE',
      'OUTPUT_CHUNK',
      'RAG_INGEST',
      'RAG_CONTEXT',
      'TOOL_REQUEST',
      'TOOL_RESULT',
    ]))
    .min(1)
    .max(7)
    .default([]),
  validFrom: z.string().datetime({ offset: true }).optional(),
  expiresAt: z.string().datetime({ offset: true }),
  priority: z.number().int().min(0).max(10_000).default(100),
  pattern: z.string().trim().min(1).max(4_096),
  matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']),
  caseSensitive: z.boolean().default(false),
  enabled: z.literal(false).default(false),
};

function validateWhitelistScope(
  value: {
    policyScope: 'all' | 'specific';
    policyIds: string[];
    dimensionScope: 'all' | 'specific';
    dimensionCodes: string[];
    targetRuleIds: string[];
    directions: Array<'INPUT' | 'OUTPUT_COMPLETE' | 'OUTPUT_CHUNK' | 'RAG_INGEST' | 'RAG_CONTEXT' | 'TOOL_REQUEST' | 'TOOL_RESULT'>;
    validFrom?: string;
    expiresAt: string;
    matchType: 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex';
    pattern: string;
    caseSensitive: boolean;
  },
  context: z.RefinementCtx,
): void {
  if (value.policyScope === 'specific' && value.policyIds.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['policyIds'],
      message: 'At least one policy is required for a specific policy scope',
    });
  }
  if (value.dimensionScope !== 'specific' || value.dimensionCodes.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['dimensionScope'],
      message: 'Whitelist rules must target one or more explicit dimensions',
    });
  }
  if (new Set(value.targetRuleIds).size !== value.targetRuleIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['targetRuleIds'],
      message: 'Target rule IDs must be unique',
    });
  }
  if (new Set(value.directions).size !== value.directions.length) {
    context.addIssue({
      code: 'custom',
      path: ['directions'],
      message: 'Directions must be unique',
    });
  }
  if (value.targetRuleIds.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['targetRuleIds'],
      message: 'Whitelist rules must target one or more explicit rules',
    });
  }
  if (value.directions.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['directions'],
      message: 'Whitelist rules must target one or more explicit directions',
    });
  }
  const validFrom = value.validFrom ? Date.parse(value.validFrom) : Date.now();
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= validFrom || expiresAt <= Date.now()) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must be after the effective time and in the future' });
  }

}

export const createWhitelistRuleSchema = z
  .object(whitelistRuleFields)
  .strict()
  .superRefine(validateWhitelistScope);
export const updateWhitelistRuleSchema = z
  .object({ id: z.string().min(1).max(128), expectedRevision: z.number().int().positive(), ...whitelistRuleFields })
  .strict()
  .superRefine(validateWhitelistScope);
