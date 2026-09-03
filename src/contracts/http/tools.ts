import { z } from 'zod';

const id = z.string().min(1).max(128);
const hostname = z.string().trim().min(1).max(253).refine((value) => {
  try {
    const bracketed = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
    return new URL(`https://${bracketed}`).hostname.replace(/^\[|\]$/gu, '').toLowerCase() ===
      value.replace(/^\[|\]$/gu, '').toLowerCase();
  } catch {
    return false;
  }
}, 'A bare hostname or IP address is required');
const scalar = z.union([z.string().max(32_768), z.number(), z.boolean(), z.null()]);
const sideEffect = z.enum([
  'NONE',
  'READ',
  'WRITE',
  'EXECUTE',
  'EXTERNAL_COMMUNICATION',
  'FINANCIAL',
  'PRIVILEGE_CHANGE',
]);
const actionIntent = z.object({
  intentId: id,
  userGoal: z.string().trim().min(1).max(8_192),
  toolName: z.string().min(1).max(200),
  parametersDigest: z.string().regex(/^[a-f0-9]{64}$/),
  targetResource: z.string().min(1).max(1_000),
  sideEffect,
  requiredPermissions: z.array(z.string().min(1).max(128)).max(100),
  supportingEnvelopeIds: z.array(id).max(1_000),
  dataDestinations: z.array(z.string().min(1).max(1_000)).max(100),
  riskBudget: z.number().int().min(0).max(10_000),
  expiresAtEpochMs: z.number().int().positive().optional(),
}).strict();

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
  sideEffect: sideEffect.default('READ'),
  requiredPermissions: z.array(z.string().min(1).max(128)).max(100).default([]),
  allowedDataDestinations: z.array(z.string().min(1).max(1_000)).max(100).default([]),
  highRisk: z.boolean().default(false),
  approvalRequired: z.boolean().default(false),
  resultGuardRequired: z.boolean().default(true),
  sourceUri: z.string().url().max(2_048),
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signatureKeyId: id,
  signature: z.string().min(43).max(512),
  licenseSpdx: z.string().trim().min(1).max(128),
  noticeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scannerDefinitionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  networkDomains: z.array(hostname).max(100),
  filePaths: z.array(z.string().min(1).max(1_000)).max(1_000),
  commands: z.array(z.string().min(1).max(1_000)).max(1_000),
  credentialRefs: z.array(id).max(100),
  approvalIds: z.array(id).min(2).max(20).refine((items) => new Set(items).size === items.length),
  isolatedDynamicAnalysis: z.boolean(),
}).strict().superRefine((value, context) => {
  for (const pattern of value.resourcePatterns) {
    if (pattern.includes('..') || pattern.includes('**') || (pattern.includes('*') && !pattern.endsWith('/*'))) {
      context.addIssue({ code: 'custom', path: ['resourcePatterns'], message: 'Only exact paths or a trailing /* prefix are allowed' });
    }
  }
  if (value.kind === 'MCP' && !value.serverIdentity) {
    context.addIssue({ code: 'custom', path: ['serverIdentity'], message: 'MCP server identity is required' });
  }
  if (/^(?:latest|main|master|head|snapshot)$/iu.test(value.version)) {
    context.addIssue({ code: 'custom', path: ['version'], message: 'An exact immutable version is required' });
  }
  const endpointHost = new URL(value.endpoint).hostname.toLowerCase();
  if (!value.networkDomains.map((item) => item.toLowerCase()).includes(endpointHost)) {
    context.addIssue({ code: 'custom', path: ['networkDomains'], message: 'Endpoint host must be declared' });
  }
  if (value.kind === 'MCP' && !value.isolatedDynamicAnalysis) {
    context.addIssue({ code: 'custom', path: ['isolatedDynamicAnalysis'], message: 'MCP admission requires isolated dynamic analysis' });
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
  agentRunId: id,
  maximumToolSteps: z.number().int().min(1).max(1_000).default(32),
  actionIntent,
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
