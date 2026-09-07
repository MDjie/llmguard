import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { gatewayRequests, gatewaySteps, toolInvocations } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { validateActiveContext } from '@/lib/gateway-runtime/authorization';
import { readProcessingContext } from '@/lib/gateway-runtime/evaluation';
import { sha256 } from '@/lib/gateway-runtime/protocol';
import { ToolPolicyError } from './policy';

export function requiresToolAuthority(sideEffect: string | null, highRisk = false): boolean {
  return highRisk || !['NONE', 'READ'].includes(sideEffect ?? 'UNKNOWN');
}

/** IDs are references, never caller-supplied claims that a source is trusted. */
export async function assertToolAuthority(input: {
  scope: TenantScope; principalId: string; bundleId: string; supportingEnvelopeIds: readonly string[];
}): Promise<void> {
  const ids = input.supportingEnvelopeIds;
  if (!ids.length || ids.length > 32 || new Set(ids).size !== ids.length) throw new ToolPolicyError('TOOL_AUTHORITY_REQUIRED', 'One to 32 distinct authenticated input references are required');
  for (const id of ids) {
    const match = /^gw\/([a-zA-Z0-9_-]{8,80})\/([a-f0-9]{32})$/u.exec(id);
    if (!match) throw new ToolPolicyError('TOOL_AUTHORITY_REFERENCE_INVALID', 'Expected an authenticated gateway input reference');
    const [row] = await db.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, input.scope), eq(gatewayRequests.id, match[1]), eq(gatewayRequests.subjectId, input.principalId))).limit(1);
    if (!row || !['AUTHORIZED', 'SEND_INTENT', 'UPSTREAM_STARTED', 'RELEASING', 'WRITTEN', 'COMPLETED'].includes(row.state)) throw new ToolPolicyError('TOOL_AUTHORITY_UNAVAILABLE', 'The referenced input is not available to this principal');
    await validateActiveContext(row.authContext);
    if (row.authContext.context.policy.bundleId !== input.bundleId) throw new ToolPolicyError('TOOL_AUTHORITY_POLICY_MISMATCH', 'The source and tool must use the same approved policy');
    const segment = readProcessingContext(row).inputSegments.find(value => value.segmentId === match[2]);
    if (!segment || segment.role !== 'user' || segment.sourceType !== 'USER' || sha256(segment.text) !== segment.sourceDigest) throw new ToolPolicyError('TOOL_AUTHORITY_SOURCE_FORBIDDEN', 'Only authenticated user input can support an action; model, RAG and tool content cannot');
    const [step] = await db.select({ id: gatewaySteps.id }).from(gatewaySteps).where(and(scopePredicate(gatewaySteps, input.scope), eq(gatewaySteps.requestId, row.id), eq(gatewaySteps.stage, 'INPUT'), eq(gatewaySteps.status, 'SUCCEEDED'), eq(gatewaySteps.coverage, 'COMPLETE'), inArray(gatewaySteps.action, ['ALLOW', 'WARN']))).limit(1);
    if (!step) throw new ToolPolicyError('TOOL_AUTHORITY_UNINSPECTED', 'The original input must have a complete successful allow or warn decision');
  }
}

/** Compensation is a new approved action, possible only after the original effect is known. */
export async function assertCompensationParent(input: {
  scope: TenantScope; principalId: string; agentRunId: string; resource: string; parentId: string;
}): Promise<typeof toolInvocations.$inferSelect> {
  const [parent] = await db.select().from(toolInvocations).where(and(scopePredicate(toolInvocations, input.scope), eq(toolInvocations.id, input.parentId), eq(toolInvocations.principalId, input.principalId))).limit(1);
  const confirmed = parent?.executionReceipt?.status === 'SUCCEEDED' || parent?.executionReconciliations.some(entry => {
    const receipt = entry.receipt;
    return receipt !== null && typeof receipt === 'object' && 'status' in receipt && receipt.status === 'SUCCEEDED';
  });
  if (!parent || !confirmed || !parent.permitConsumedAt || !parent.executionRequestDigest || parent.compensatesInvocationId || !['completed', 'result_blocked'].includes(parent.status) || !requiresToolAuthority(parent.sideEffect) || parent.agentRunId !== input.agentRunId || parent.resource !== input.resource) throw new ToolPolicyError('TOOL_COMPENSATION_PARENT_INVALID', 'Compensation requires a confirmed original effect in the same scope, principal, run and resource');
  return parent;
}
