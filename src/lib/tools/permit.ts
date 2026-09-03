import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/policy-bundle';
import { ToolPolicyError } from './policy';

const permitSchema = z.object({
  version: z.literal(2), invocationId: z.string(), tenantId: z.string(), applicationId: z.string(),
  subjectId: z.string(), agentRunId: z.string(), toolId: z.string(), toolVersion: z.string(),
  bundleId: z.string(), action: z.string(), resourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  parametersHash: z.string().regex(/^[a-f0-9]{64}$/),
  actionIntentHash: z.string().regex(/^[a-f0-9]{64}$/),
  approvalDecisionId: z.string().optional(),
  expiresAt: z.number().int().positive(),
}).strict();
export type ToolPermit = z.infer<typeof permitSchema>;

function key(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.TOOL_PERMIT_KEY;
  if (!value || Buffer.byteLength(value) < 32) throw new Error('TOOL_PERMIT_KEY must contain at least 32 bytes');
  return value;
}

export function signToolPermit(permit: ToolPermit, environment = process.env): string {
  const payload = Buffer.from(canonicalJson(permit)).toString('base64url');
  const signature = createHmac('sha256', key(environment)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyToolPermit(token: string, environment = process.env, now = Date.now()): ToolPermit {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new ToolPolicyError('TOOL_PERMIT_INVALID', 'Permit token format is invalid');
  const expected = Buffer.from(createHmac('sha256', key(environment)).update(payload).digest('base64url'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ToolPolicyError('TOOL_PERMIT_INVALID', 'Permit token signature is invalid');
  }
  const permit = permitSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  if (permit.expiresAt <= now) throw new ToolPolicyError('TOOL_PERMIT_EXPIRED', 'Permit token expired');
  return permit;
}
