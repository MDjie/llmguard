import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { toolInvocations, toolRegistry } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { gatewaySetting } from '@/lib/gateway-runtime/settings';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { configuredToolExecutor, executorConfigurationHash, prepareToolExecutionQuery, type ToolExecutorReceipt } from './executor';
import { evaluateInvocationResult } from './service';
import { ToolPolicyError } from './policy';

function publicStatus(invocation: typeof toolInvocations.$inferSelect) {
  const records = invocation.executionReconciliations;
  return { invocationId: invocation.id, status: invocation.status, permitConsumed: Boolean(invocation.permitConsumedAt),
    receipt: invocation.executionReceipt, reconciliations: records, resultReturned: false };
}

/** A query has no action or parameters and cannot restore a consumed execution permit. */
export async function reconcileToolInvocation(input: { scope: TenantScope; principalId: string; invocationId: string; queryId: string; signal: AbortSignal }) {
  const predicate = and(scopePredicate(toolInvocations, input.scope), eq(toolInvocations.id, input.invocationId), eq(toolInvocations.principalId, input.principalId));
  const [invocation] = await db.select().from(toolInvocations).where(predicate).limit(1);
  if (!invocation) throw new ToolPolicyError('TOOL_INVOCATION_MISSING', 'Invocation is unavailable in this scope');
  if (invocation.executionReconciliations.some(record => record.queryId === input.queryId) || invocation.status !== 'execution_unknown') return publicStatus(invocation);
  if (!invocation.permitConsumedAt || !invocation.executionRequestDigest || !invocation.executionDeadlineAt || !invocation.executorId || !invocation.toolVersion) throw new ToolPolicyError('TOOL_RECONCILIATION_BINDING_MISSING', 'The original execution is not fully bound');
  if (invocation.executionReconciliations.length >= 32) throw new ToolPolicyError('TOOL_RECONCILIATION_LIMIT', 'The invocation query evidence budget is exhausted');
  const [tool] = await db.select().from(toolRegistry).where(and(scopePredicate(toolRegistry, input.scope), eq(toolRegistry.id, invocation.toolId))).limit(1);
  // Disabled tools may still answer a read-only outcome query. Endpoint/version/key
  // configuration must remain exactly the binding approved for the original action.
  const executor = tool && configuredToolExecutor(input.scope, tool);
  if (!executor || executorConfigurationHash(executor) !== invocation.executorConfigurationHash) throw new ToolPolicyError('TOOL_EXECUTOR_UNAVAILABLE', 'The original approved executor configuration is unavailable');
  const auditKey = gatewaySetting('AUDIT_CHAIN_KEY', 'AUDIT_CHAIN_KEY_FILE');
  if (!auditKey || Buffer.byteLength(auditKey) < 32) throw new ToolPolicyError('TOOL_AUDIT_KEY_UNAVAILABLE', 'Query evidence key is unavailable');
  const prepared = prepareToolExecutionQuery(executor, { protocolVersion: '1.0', operation: 'QUERY', queryId: input.queryId, invocationId: invocation.id,
    ...input.scope, subjectId: input.principalId, toolId: invocation.toolId, toolVersion: invocation.toolVersion, executorId: invocation.executorId,
    originalRequestDigest: invocation.executionRequestDigest, originalDeadlineEpochMs: invocation.executionDeadlineAt.getTime(), deadlineEpochMs: Date.now() + Math.min(10000, executor.timeoutMs) }, input.signal);
  let receipt: ToolExecutorReceipt | undefined;
  try { receipt = await prepared.send(); } catch { /* Persist uncertainty without re-executing the action. */ }
  const metadata: Record<string, unknown> = { queryId: input.queryId, queryDigest: prepared.requestDigest, queriedAtEpochMs: Date.now(), outcome: receipt ? 'RECEIPT' : 'QUERY_FAILED', transport: 'PINNED_MTLS' };
  if (receipt) {
    const { result, ...value } = receipt;
    metadata.receipt = value;
    if (sha256(result) !== value.resultDigest) throw new ToolPolicyError('TOOL_EXECUTION_RECEIPT_INVALID', 'Result digest is inconsistent');
  }
  const claimed = await db.transaction(async transaction => {
    const [current] = await transaction.select().from(toolInvocations).where(predicate).limit(1).for('update');
    if (!current || current.executionRequestDigest !== invocation.executionRequestDigest || current.executorConfigurationHash !== invocation.executorConfigurationHash) throw new ToolPolicyError('TOOL_RECONCILIATION_BINDING_CHANGED', 'Invocation binding changed during query');
    if (current.status !== 'execution_unknown' || current.executionReconciliations.some(record => record.queryId === input.queryId)) return { invocation: current, inspect: false };
    if (current.executionReconciliations.length >= 32) throw new ToolPolicyError('TOOL_RECONCILIATION_LIMIT', 'The invocation query evidence budget is exhausted');
    const previous = current.executionReconciliations.at(-1)?.evidenceHmac ?? sha256(canonicalJson([input.scope.tenantId, input.scope.applicationId, invocation.id, 'tool-reconciliation-v1']));
    const entry = { ...metadata, previousHmac: previous, keyId: process.env.AUDIT_CHAIN_KEY_ID ?? 'default' };
    const record = { ...entry, evidenceHmac: createHmac('sha256', auditKey).update(canonicalJson(entry)).digest('hex') };
    const [updated] = await transaction.update(toolInvocations).set({
      executionReconciliations: [...current.executionReconciliations, record],
      status: receipt?.status === 'SUCCEEDED' ? 'result_processing' : receipt?.status === 'REJECTED' ? 'execution_rejected' : 'execution_unknown',
      completedAt: new Date(),
    }).where(predicate).returning();
    return { invocation: updated, inspect: receipt?.status === 'SUCCEEDED' };
  });
  if (claimed.inspect && receipt) {
    try { await evaluateInvocationResult(claimed.invocation, receipt.result); }
    catch { /* The common result guard durably records result_blocked. */ }
  }
  const [current] = await db.select().from(toolInvocations).where(predicate).limit(1);
  return publicStatus(current ?? claimed.invocation);
}
