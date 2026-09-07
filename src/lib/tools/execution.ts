import { assertToolAuthority, assertCompensationParent, requiresToolAuthority } from './authority';
import { and, eq, lt, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import { gatewaySetting } from '@/lib/gateway-runtime/settings';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { toolInvocations, toolRegistry } from '@/storage/database/shared/schema';
import { verifyToolPermit } from './permit';
import { ToolPolicyError } from './policy';
import { assertExecutionClaims } from './execution-claims';
import { configuredToolExecutor, executorConfigurationHash, prepareToolExecution, type ToolExecutionRequest } from './executor';
import { evaluateInvocationResult } from './service';

function evidenceKey(): string {
  const key = gatewaySetting('AUDIT_CHAIN_KEY', 'AUDIT_CHAIN_KEY_FILE');
  if (!key || Buffer.byteLength(key) < 32) throw new ToolPolicyError('TOOL_AUDIT_KEY_UNAVAILABLE', 'Execution evidence key is unavailable');
  return key;
}
export async function executeToolInvocation(input: {
  scope: TenantScope; principalId: string; invocationId: string; permitToken: string;
  parameters: Readonly<Record<string, unknown>>; signal: AbortSignal;
}) {
  const permit = verifyToolPermit(input.permitToken);
  if (permit.tenantId !== input.scope.tenantId || permit.applicationId !== input.scope.applicationId ||
      permit.subjectId !== input.principalId || permit.invocationId !== input.invocationId) {
    throw new ToolPolicyError('TOOL_PERMIT_SCOPE_MISMATCH', 'Permit does not match the authenticated scope');
  }
  await loadVerifiedPolicyBundle(input.scope, permit.bundleId);
  const [invocation] = await db.select().from(toolInvocations).where(and(
    scopePredicate(toolInvocations, input.scope), eq(toolInvocations.id, input.invocationId),
  )).limit(1);
  if (!invocation) throw new ToolPolicyError('TOOL_INVOCATION_MISSING', 'Invocation is unavailable');
  assertExecutionClaims(permit, invocation, input.principalId, input.parameters);
  if (invocation.status !== 'authorized') throw new ToolPolicyError('TOOL_PERMIT_ALREADY_CONSUMED', 'Execution permit cannot be replayed');
  const [tool] = await db.select().from(toolRegistry).where(and(
    scopePredicate(toolRegistry, input.scope), eq(toolRegistry.id, permit.toolId), eq(toolRegistry.status, 'active'),
  )).limit(1);
  const executor = tool && configuredToolExecutor(input.scope, tool);
  if (!executor || executorConfigurationHash(executor) !== permit.executorConfigurationHash) {
    throw new ToolPolicyError('TOOL_EXECUTOR_UNAVAILABLE', 'The approved executor configuration has changed or is unavailable');
  }
  if (requiresToolAuthority(invocation.sideEffect, tool?.highRisk)) {
    if (!invocation.approvalDecisionId) throw new ToolPolicyError('TOOL_APPROVAL_REQUIRED', 'High risk execution requires a distinct approval');
    await assertToolAuthority({ ...input, bundleId: invocation.bundleId, supportingEnvelopeIds: invocation.supportingEnvelopeIds });
  }
  const parent = invocation.compensatesInvocationId ? await assertCompensationParent({ ...input, parentId: invocation.compensatesInvocationId, agentRunId: permit.agentRunId, resource: invocation.resource }) : undefined;
  const key = evidenceKey();
  const deadlineEpochMs = Math.min(permit.expiresAt, Date.now() + executor.timeoutMs);
  const body: ToolExecutionRequest = {
    ...(parent ? { compensatesInvocationId: parent.id, originalExecutionDigest: parent.executionRequestDigest! } : {}),
    protocolVersion: '1.0', ...input.scope, invocationId: invocation.id, subjectId: input.principalId,
    agentRunId: permit.agentRunId, toolId: permit.toolId, toolVersion: permit.toolVersion,
    action: permit.action, resource: invocation.resource, parameters: input.parameters,
    parametersHash: permit.parametersHash, actionIntentHash: permit.actionIntentHash,
    bundleId: permit.bundleId, definitionDigest: executor.definitionDigest, executorId: executor.executorId, deadlineEpochMs,
  };
  const prepared = prepareToolExecution(executor, body, input.signal);
  input.signal.throwIfAborted();
  // This commit is the durable send intent. No network effect occurs while holding a DB transaction.
  await db.transaction(async transaction => {
    const [currentTool] = await transaction.select().from(toolRegistry).where(and(
      scopePredicate(toolRegistry, input.scope), eq(toolRegistry.id, permit.toolId), eq(toolRegistry.status, 'active'),
    )).limit(1).for('share');
    const currentExecutor = currentTool && configuredToolExecutor(input.scope, currentTool);
    if (!currentExecutor || executorConfigurationHash(currentExecutor) !== permit.executorConfigurationHash) {
      throw new ToolPolicyError('TOOL_EXECUTOR_UNAVAILABLE', 'Executor changed before consumption');
    }
    const [claimed] = await transaction.update(toolInvocations).set({
      status: 'executing', permitConsumedAt: new Date(), executionStartedAt: new Date(),
      executionDeadlineAt: new Date(deadlineEpochMs), executionRequestDigest: prepared.requestDigest,
    }).where(and(scopePredicate(toolInvocations, input.scope), eq(toolInvocations.id, input.invocationId),
      eq(toolInvocations.status, 'authorized'), eq(toolInvocations.executorConfigurationHash, permit.executorConfigurationHash!),
      sql`${toolInvocations.permitExpiresAt} > now()`,
    )).returning();
    if (!claimed) throw new ToolPolicyError('TOOL_PERMIT_ALREADY_CONSUMED', 'Permit is expired or already consumed');
    assertExecutionClaims(permit, claimed, input.principalId, input.parameters);
  });
  try {
    // Never retry: the peer may have committed its side effect even if this connection fails.
    const receipt = await prepared.send();
    const { result, ...metadata } = receipt;
    const persisted = {
      ...metadata, evidenceHmac: createHmac('sha256', key).update(canonicalJson(metadata)).digest('hex'),
      receivedAtEpochMs: Date.now(), transport: 'PINNED_MTLS',
    };
    const [recorded] = await db.update(toolInvocations).set({
      status: receipt.status === 'SUCCEEDED' ? 'result_processing' : receipt.status === 'REJECTED' ? 'execution_rejected' : 'execution_unknown',
      executionReceipt: persisted,
      ...(receipt.status !== 'SUCCEEDED' ? { completedAt: new Date() } : {}),
    }).where(and(scopePredicate(toolInvocations, input.scope), eq(toolInvocations.id, invocation.id),
      eq(toolInvocations.status, 'executing'),
    )).returning();
    if (!recorded) throw new ToolPolicyError('TOOL_EXECUTION_UNKNOWN', 'Receipt could not be durably matched to the pending execution');
    if (receipt.status === 'UNKNOWN') throw new ToolPolicyError('TOOL_EXECUTION_UNKNOWN', 'Executor cannot confirm the side effect');
    if (receipt.status === 'REJECTED') return { action: 'BLOCK', invocationId: invocation.id, executionState: 'REJECTED', receipt: persisted };
    const guarded = await evaluateInvocationResult(recorded, result);
    return { ...guarded, invocationId: invocation.id, executionState: 'SUCCEEDED', receipt: persisted,
      ...(guarded.action === 'ALLOW' && !input.signal.aborted ? { result } : {}) };
  } catch (error) {
    await db.update(toolInvocations).set({ status: 'execution_unknown', completedAt: new Date() }).where(and(
      scopePredicate(toolInvocations, input.scope), eq(toolInvocations.id, invocation.id), eq(toolInvocations.status, 'executing'),
    ));
    if (error instanceof ToolPolicyError) throw error;
    throw new ToolPolicyError('TOOL_EXECUTION_UNKNOWN', 'Execution or result verification failed; the permit remains consumed');
  }
}
/** Crash recovery records uncertainty; it never resubmits the external action. */
export async function reconcileToolExecutions(now = new Date()): Promise<number> {
  const rows = await db.update(toolInvocations).set({ status: 'execution_unknown', completedAt: now })
    .where(and(eq(toolInvocations.status, 'executing'), lt(toolInvocations.executionDeadlineAt, new Date(now.getTime() - 30000))))
    .returning({ id: toolInvocations.id });
  return rows.length;
}
