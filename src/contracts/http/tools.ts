import { z } from 'zod';

const id = z.string().min(1).max(128);
const scalar = z.union([z.string().max(32_768), z.number(), z.boolean(), z.null()]);

export const registerToolSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._+-]+$/),
  kind: z.enum(['HTTP', 'MCP']),
  endpoint: z.string().url().max(1_000),
  serverIdentity: z.string().max(500).optional(),
  allowedRoles: z.array(z.string().max(100)).max(100),
  allowedActions: z.array(z.string().min(1).max(128)).min(1).max(100),
  resourcePatterns: z.array(z.string().min(1).max(1_000)).min(1).max(1_000),
  parameterPolicy: z.object({
    required: z.array(z.string().max(100)).max(100).default([]),
    allowedKeys: z.array(z.string().max(100)).max(1_000),
    maxStringLength: z.number().int().min(1).max(1_048_576).default(32_768),
    enums: z.record(z.string().max(100), z.array(scalar).max(1_000)).default({}),
  }).strict(),
  highRisk: z.boolean().default(false),
  approvalRequired: z.boolean().default(false),
  resultGuardRequired: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  for (const pattern of value.resourcePatterns) {
    if (pattern.includes('..') || pattern.includes('**') || (pattern.includes('*') && !pattern.endsWith('/*'))) {
      context.addIssue({ code: 'custom', path: ['resourcePatterns'], message: 'Only exact paths or a trailing /* prefix are allowed' });
    }
  }
  if (value.kind === 'MCP' && !value.serverIdentity) {
    context.addIssue({ code: 'custom', path: ['serverIdentity'], message: 'MCP server identity is required' });
  }
});

export const authorizeToolSchema = z.object({
  traceId: z.string().min(16).max(128),
  requestId: z.string().min(8).max(128),
  bundleId: id,
  toolId: id,
  action: z.string().min(1).max(128),
  resource: z.string().min(1).max(1_000),
  parameters: z.record(z.string().max(100), scalar),
  contextTainted: z.boolean().default(false),
}).strict();

export const toolResultSchema = z.object({
  invocationId: id,
  permitToken: z.string().min(32).max(4_096),
  result: z.string().max(1_048_576),
}).strict();

export const toolApprovalSchema = z.object({
  invocationId: id,
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(1).max(500),
}).strict();
