import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { canonicalJson, loadRuntimePolicyBundle } from '@/lib/policy-bundle';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { toolApprovals, toolInvocations, toolRegistry } from '@/storage/database/shared/schema';
import { signToolPermit, verifyToolPermit } from './permit';
import { resourceMatches, ToolPolicyError, validateToolParameters } from './policy';

function parameterHash(parameters: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(parameters)).digest('hex');
}

function permitFor(invocation: typeof toolInvocations.$inferSelect): string {
  if (!invocation.permitExpiresAt) throw new ToolPolicyError('TOOL_PERMIT_UNAVAILABLE', 'Invocation has no permit expiry');
  return signToolPermit({
    version: 1,
    invocationId: invocation.id,
    tenantId: invocation.tenantId,
    applicationId: invocation.applicationId,
    toolId: invocation.toolId,
    bundleId: invocation.bundleId,
    parametersHash: invocation.parametersHash,
    expiresAt: invocation.permitExpiresAt.getTime(),
  });
}

export async function authorizeToolInvocation(input: {
  scope: TenantScope;
  principalId: string;
  roles: readonly string[];
  traceId: string;
  requestId: string;
  bundleId: string;
  toolId: string;
  action: string;
  resource: string;
  parameters: Readonly<Record<string, unknown>>;
  contextTainted: boolean;
}) {
  await loadRuntimePolicyBundle(input.scope, input.bundleId, input.requestId);
  const [tool] = await db.select().from(toolRegistry).where(and(
    eq(toolRegistry.id, input.toolId), eq(toolRegistry.status, 'active'), scopePredicate(toolRegistry, input.scope),
  )).limit(1);
  if (!tool) throw new ToolPolicyError('TOOL_UNKNOWN_OR_DISABLED', 'Unknown, cross-scope or disabled tool/MCP server');
  if ((tool.allowedRoles ?? []).length > 0 && !(tool.allowedRoles ?? []).some((role) => input.roles.includes(role))) {
    throw new ToolPolicyError('TOOL_ROLE_DENIED', 'Principal role is not authorized for this tool');
  }
  if (!(tool.allowedActions ?? []).includes(input.action)) {
    throw new ToolPolicyError('TOOL_ACTION_DENIED', 'Tool action is not authorized');
  }
  if (!resourceMatches(tool.resourcePatterns ?? [], input.resource)) {
    throw new ToolPolicyError('TOOL_RESOURCE_DENIED', 'Tool resource is outside the approved patterns');
  }
  validateToolParameters(tool.parameterPolicy ?? {}, input.parameters);
  if (input.contextTainted && tool.highRisk) {
    throw new ToolPolicyError('TOOL_TAINTED_CONTEXT_DENIED', 'Tainted RAG/tool context cannot invoke a high-risk tool');
  }
  const parametersHash = parameterHash(input.parameters);
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.scope.tenantId}:${input.scope.applicationId}:${input.requestId}`}))`);
    const [existing] = await transaction.select().from(toolInvocations).where(and(
      scopePredicate(toolInvocations, input.scope), eq(toolInvocations.requestId, input.requestId),
    )).limit(1).for('update');
    if (existing) {
      if (existing.toolId !== input.toolId || existing.action !== input.action ||
          existing.resource !== input.resource || existing.parametersHash !== parametersHash ||
          existing.bundleId !== input.bundleId) {
        throw new ToolPolicyError('TOOL_IDEMPOTENCY_CONFLICT', 'Request ID was used for different tool claims');
      }
      if (existing.status === 'pending_approval') return { disposition: 'REQUIRE_APPROVAL' as const, invocation: existing };
      if (existing.status === 'approved') {
        const expiresAt = new Date(Date.now() + 60_000);
        const [authorized] = await transaction.update(toolInvocations).set({
          status: 'authorized', permitExpiresAt: expiresAt,
        }).where(and(eq(toolInvocations.id, existing.id), scopePredicate(toolInvocations, input.scope))).returning();
        return { disposition: 'ALLOW' as const, invocation: authorized, permitToken: permitFor(authorized) };
      }
      if (existing.status === 'authorized' && existing.permitExpiresAt && existing.permitExpiresAt > new Date()) {
        return { disposition: 'ALLOW' as const, invocation: existing, permitToken: permitFor(existing) };
      }
      throw new ToolPolicyError('TOOL_INVOCATION_TERMINAL', 'Invocation cannot be re-authorized');
    }
    const requiresApproval = tool.highRisk || tool.approvalRequired;
    const expiresAt = requiresApproval ? null : new Date(Date.now() + 60_000);
    const [invocation] = await transaction.insert(toolInvocations).values({
      ...input.scope,
      requestId: input.requestId,
      traceId: input.traceId,
      principalId: input.principalId,
      toolId: input.toolId,
      bundleId: input.bundleId,
      action: input.action,
      resource: input.resource,
      parametersHash,
      contextTainted: input.contextTainted,
      status: requiresApproval ? 'pending_approval' : 'authorized',
      permitExpiresAt: expiresAt,
    }).returning();
    if (requiresApproval) {
      await transaction.insert(toolApprovals).values({
        ...input.scope, invocationId: invocation.id, requesterId: input.principalId,
      });
      return { disposition: 'REQUIRE_APPROVAL' as const, invocation };
    }
    return { disposition: 'ALLOW' as const, invocation, permitToken: permitFor(invocation) };
  });
}

export async function decideToolApproval(
  scope: TenantScope,
  approverId: string,
  invocationId: string,
  decision: 'approve' | 'reject',
  reason: string,
) {
  return db.transaction(async (transaction) => {
    const [approval] = await transaction.update(toolApprovals).set({
      status: decision === 'approve' ? 'approved' : 'rejected',
      approverId, reason, decidedAt: new Date(),
    }).where(and(
      eq(toolApprovals.invocationId, invocationId), eq(toolApprovals.status, 'pending'),
      sql`${toolApprovals.requesterId} <> ${approverId}`,
      scopePredicate(toolApprovals, scope),
    )).returning();
    if (!approval) throw new ToolPolicyError('TOOL_APPROVAL_REJECTED', 'A different principal must decide a pending approval');
    const [invocation] = await transaction.update(toolInvocations).set({
      status: decision === 'approve' ? 'approved' : 'denied',
    }).where(and(eq(toolInvocations.id, invocationId), scopePredicate(toolInvocations, scope))).returning();
    return { approval, invocation };
  });
}

export async function guardToolResult(input: {
  scope: TenantScope;
  invocationId: string;
  permitToken: string;
  result: string;
}) {
  const permit = verifyToolPermit(input.permitToken);
  if (permit.invocationId !== input.invocationId || permit.tenantId !== input.scope.tenantId ||
      permit.applicationId !== input.scope.applicationId) {
    throw new ToolPolicyError('TOOL_PERMIT_SCOPE_MISMATCH', 'Permit does not match the invocation scope');
  }
  const invocation = await db.transaction(async (transaction) => {
    const [claimed] = await transaction.update(toolInvocations).set({ status: 'result_processing' }).where(and(
      eq(toolInvocations.id, input.invocationId),
      eq(toolInvocations.status, 'authorized'),
      eq(toolInvocations.toolId, permit.toolId),
      eq(toolInvocations.bundleId, permit.bundleId),
      eq(toolInvocations.parametersHash, permit.parametersHash),
      scopePredicate(toolInvocations, input.scope),
    )).returning();
    if (!claimed) throw new ToolPolicyError('TOOL_PERMIT_ALREADY_CONSUMED', 'Permit is invalid or already consumed');
    return claimed;
  });
  try {
    const bundle = await loadRuntimePolicyBundle(input.scope, invocation.bundleId, invocation.requestId);
    const decision = await createEngineForPolicyBundle(bundle).evaluate({
      contractVersion: '1.0',
      context: {
        traceId: invocation.traceId,
        requestId: `${invocation.requestId}-result`,
        tenantId: input.scope.tenantId,
        applicationId: input.scope.applicationId,
        direction: 'TOOL_RESULT',
        absoluteDeadlineEpochMs: Date.now() + 30_000,
        policyBundleId: bundle.id,
      },
      content: { text: input.result },
    });
    const blocked = ['BLOCK', 'SAFE_RESPONSE', 'REQUIRE_REVIEW'].includes(decision.action);
    await db.update(toolInvocations).set({
      status: blocked ? 'result_blocked' : 'completed',
      resultDecision: decision as unknown as Record<string, unknown>,
      completedAt: new Date(),
    }).where(and(eq(toolInvocations.id, invocation.id), scopePredicate(toolInvocations, input.scope)));
    return { action: blocked ? 'BLOCK' : 'ALLOW', decision };
  } catch (error) {
    await db.update(toolInvocations).set({ status: 'result_blocked', completedAt: new Date() })
      .where(and(eq(toolInvocations.id, invocation.id), scopePredicate(toolInvocations, input.scope)));
    throw error;
  }
}
