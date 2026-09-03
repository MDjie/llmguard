import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { ActionIntent, SideEffect } from '@guardllm/contracts';
import { contextContentHash } from '@/lib/context-trust';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { canonicalJson, loadRuntimePolicyBundle } from '@/lib/policy-bundle';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  agentLifecycleBudgets,
  toolApprovals,
  toolInvocations,
  toolRegistry,
} from '@/storage/database/shared/schema';
import { evaluateActionIntent } from './action-firewall';
import { signToolPermit, verifyToolPermit } from './permit';
import { resourceMatches, ToolPolicyError, validateToolParameters } from './policy';

function parameterHash(parameters: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(parameters)).digest('hex');
}

function valueHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sideEffect(value: string): SideEffect {
  switch (value) {
    case 'NONE':
    case 'READ':
    case 'WRITE':
    case 'EXECUTE':
    case 'EXTERNAL_COMMUNICATION':
    case 'FINANCIAL':
    case 'PRIVILEGE_CHANGE':
      return value;
    default:
      throw new ToolPolicyError('TOOL_SIDE_EFFECT_INVALID', 'Registered tool has an invalid side effect');
  }
}

function permitFor(invocation: typeof toolInvocations.$inferSelect): string {
  if (!invocation.permitExpiresAt) throw new ToolPolicyError('TOOL_PERMIT_UNAVAILABLE', 'Invocation has no permit expiry');
  if (!invocation.agentRunId || !invocation.toolVersion || !invocation.actionIntentHash) {
    throw new ToolPolicyError('TOOL_PERMIT_UNAVAILABLE', 'Invocation is missing Action Firewall bindings');
  }
  return signToolPermit({
    version: 2,
    invocationId: invocation.id,
    tenantId: invocation.tenantId,
    applicationId: invocation.applicationId,
    subjectId: invocation.principalId,
    agentRunId: invocation.agentRunId,
    toolId: invocation.toolId,
    toolVersion: invocation.toolVersion,
    bundleId: invocation.bundleId,
    action: invocation.action,
    resourceHash: valueHash(invocation.resource),
    parametersHash: invocation.parametersHash,
    actionIntentHash: invocation.actionIntentHash,
    ...(invocation.approvalDecisionId
      ? { approvalDecisionId: invocation.approvalDecisionId }
      : {}),
    expiresAt: invocation.permitExpiresAt.getTime(),
  });
}

export async function authorizeToolInvocation(input: {
  scope: TenantScope;
  principalId: string;
  roles: readonly string[];
  permissions: readonly string[];
  traceId: string;
  requestId: string;
  bundleId: string;
  toolId: string;
  action: string;
  resource: string;
  parameters: Readonly<Record<string, unknown>>;
  agentRunId: string;
  maximumToolSteps: number;
  actionIntent: ActionIntent;
  contextTainted: boolean;
}) {
  await loadRuntimePolicyBundle(input.scope, input.bundleId, input.requestId);
  const [tool] = await db.select().from(toolRegistry).where(and(
    eq(toolRegistry.id, input.toolId), eq(toolRegistry.status, 'active'), scopePredicate(toolRegistry, input.scope),
  )).limit(1);
  if (!tool) throw new ToolPolicyError('TOOL_UNKNOWN_OR_DISABLED', 'Unknown, cross-scope or disabled tool/MCP server');
  if (!tool.sourceUri || !tool.sourceDigest || !tool.signatureKeyId || !tool.signature ||
      !tool.licenseSpdx || !tool.noticeDigest || !tool.scannerDefinitionDigest ||
      new Set(tool.approvalIds ?? []).size < 2 ||
      (tool.kind === 'MCP' && !tool.isolatedDynamicAnalysis)) {
    throw new ToolPolicyError(
      'TOOL_SUPPLY_CHAIN_ADMISSION_REQUIRED',
      'Tool or MCP version has not completed signed supply-chain admission',
    );
  }
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
  const parametersHash = parameterHash(input.parameters);
  const actionIntentHash = valueHash(canonicalJson(input.actionIntent));
  const firewall = evaluateActionIntent({
    intent: input.actionIntent,
    now: Date.now(),
    parametersDigest: parametersHash,
    principalPermissions: input.permissions,
    tool: {
      name: tool.name,
      sideEffect: sideEffect(tool.sideEffect),
      requiredPermissions: tool.requiredPermissions ?? [],
      allowedDataDestinations: tool.allowedDataDestinations ?? [],
      highRisk: tool.highRisk,
      approvalRequired: tool.approvalRequired,
    },
    action: input.action,
    resource: input.resource,
    contextTainted: input.contextTainted,
  });
  if (firewall.disposition === 'BLOCK' || firewall.disposition === 'REWRITE') {
    return firewall;
  }
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.scope.tenantId}:${input.scope.applicationId}:${input.requestId}`}))`);
    const [existing] = await transaction.select().from(toolInvocations).where(and(
      scopePredicate(toolInvocations, input.scope), eq(toolInvocations.requestId, input.requestId),
    )).limit(1).for('update');
    if (existing) {
      if (existing.toolId !== input.toolId || existing.action !== input.action ||
          existing.resource !== input.resource || existing.parametersHash !== parametersHash ||
          existing.bundleId !== input.bundleId || existing.agentRunId !== input.agentRunId ||
          existing.actionIntentHash !== actionIntentHash) {
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
    const [budget] = await transaction.select().from(agentLifecycleBudgets).where(and(
      scopePredicate(agentLifecycleBudgets, input.scope),
      eq(agentLifecycleBudgets.agentRunId, input.agentRunId),
    )).limit(1).for('update');
    const activeBudget = budget && budget.expiresAt > new Date() ? budget : undefined;
    if (activeBudget && (
      activeBudget.principalId !== input.principalId ||
      activeBudget.allocatedRiskBudget !== input.actionIntent.riskBudget ||
      activeBudget.maximumToolSteps !== input.maximumToolSteps
    )) {
      throw new ToolPolicyError('TOOL_AGENT_BUDGET_CONFLICT', 'Agent run budget claims cannot change');
    }
    const consumedRiskBudget = (activeBudget?.consumedRiskBudget ?? 0) + firewall.riskCost;
    const toolSteps = (activeBudget?.toolSteps ?? 0) + 1;
    if (consumedRiskBudget > input.actionIntent.riskBudget || toolSteps > input.maximumToolSteps) {
      return {
        disposition: 'BLOCK' as const,
        reasonCodes: [toolSteps > input.maximumToolSteps
          ? 'ACTION_TOOL_STEP_BUDGET_EXCEEDED'
          : 'ACTION_LIFECYCLE_RISK_BUDGET_EXCEEDED'],
        riskCost: firewall.riskCost,
        attributionStatus: 'NOT_REQUIRED' as const,
        repairSuggestion: {
          remainingRiskBudget: Math.max(
            0,
            input.actionIntent.riskBudget - (activeBudget?.consumedRiskBudget ?? 0),
          ),
          remainingToolSteps: Math.max(0, input.maximumToolSteps - (activeBudget?.toolSteps ?? 0)),
        },
      };
    }
    const budgetExpiresAt = new Date(Math.min(
      input.actionIntent.expiresAtEpochMs ?? Date.now() + 60 * 60 * 1_000,
      Date.now() + 24 * 60 * 60 * 1_000,
    ));
    await transaction.insert(agentLifecycleBudgets).values({
      ...input.scope,
      agentRunId: input.agentRunId,
      principalId: input.principalId,
      allocatedRiskBudget: input.actionIntent.riskBudget,
      consumedRiskBudget,
      toolSteps,
      maximumToolSteps: input.maximumToolSteps,
      state: 'ACTIVE',
      expiresAt: budgetExpiresAt,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [
        agentLifecycleBudgets.tenantId,
        agentLifecycleBudgets.applicationId,
        agentLifecycleBudgets.agentRunId,
      ],
      set: {
        principalId: input.principalId,
        allocatedRiskBudget: input.actionIntent.riskBudget,
        consumedRiskBudget,
        toolSteps,
        maximumToolSteps: input.maximumToolSteps,
        state: 'ACTIVE',
        expiresAt: budgetExpiresAt,
        updatedAt: new Date(),
      },
    });
    const requiresApproval = firewall.disposition === 'REQUIRE_APPROVAL';
    const expiresAt = requiresApproval ? null : new Date(Date.now() + 60_000);
    const [invocation] = await transaction.insert(toolInvocations).values({
      ...input.scope,
      requestId: input.requestId,
      traceId: input.traceId,
      principalId: input.principalId,
      agentRunId: input.agentRunId,
      toolId: input.toolId,
      toolVersion: tool.version,
      bundleId: input.bundleId,
      action: input.action,
      resource: input.resource,
      parametersHash,
      actionIntentHash,
      actionIntent: { ...input.actionIntent },
      sideEffect: sideEffect(tool.sideEffect),
      riskCost: firewall.riskCost,
      riskBudget: input.actionIntent.riskBudget,
      supportingEnvelopeIds: [...input.actionIntent.supportingEnvelopeIds],
      dataDestinations: [...input.actionIntent.dataDestinations],
      contextTainted: input.contextTainted,
      status: requiresApproval ? 'pending_approval' : 'authorized',
      permitExpiresAt: expiresAt,
    }).returning();
    if (requiresApproval) {
      await transaction.insert(toolApprovals).values({
        ...input.scope, invocationId: invocation.id, requesterId: input.principalId,
      });
      return {
        disposition: 'REQUIRE_APPROVAL' as const,
        invocation,
        reasonCodes: firewall.reasonCodes,
        riskCost: firewall.riskCost,
        attributionStatus: firewall.attributionStatus,
      };
    }
    return {
      disposition: 'ALLOW' as const,
      invocation,
      permitToken: permitFor(invocation),
      reasonCodes: firewall.reasonCodes,
      riskCost: firewall.riskCost,
      attributionStatus: firewall.attributionStatus,
    };
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
      approvalDecisionId: approval.id,
    }).where(and(eq(toolInvocations.id, invocationId), scopePredicate(toolInvocations, scope))).returning();
    return { approval, invocation };
  });
}

export async function guardToolResult(input: {
  scope: TenantScope;
  invocationId: string;
  permitToken: string;
  principalId: string;
  result: string;
}) {
  const permit = verifyToolPermit(input.permitToken);
  if (permit.invocationId !== input.invocationId || permit.tenantId !== input.scope.tenantId ||
      permit.applicationId !== input.scope.applicationId || permit.subjectId !== input.principalId) {
    throw new ToolPolicyError('TOOL_PERMIT_SCOPE_MISMATCH', 'Permit does not match the invocation scope');
  }
  const invocation = await db.transaction(async (transaction) => {
    const [claimed] = await transaction.update(toolInvocations).set({
      status: 'result_processing',
      permitConsumedAt: new Date(),
    }).where(and(
      eq(toolInvocations.id, input.invocationId),
      eq(toolInvocations.status, 'authorized'),
      eq(toolInvocations.toolId, permit.toolId),
      eq(toolInvocations.bundleId, permit.bundleId),
      eq(toolInvocations.parametersHash, permit.parametersHash),
      eq(toolInvocations.principalId, permit.subjectId),
      eq(toolInvocations.agentRunId, permit.agentRunId),
      eq(toolInvocations.toolVersion, permit.toolVersion),
      eq(toolInvocations.action, permit.action),
      eq(toolInvocations.actionIntentHash, permit.actionIntentHash),
      scopePredicate(toolInvocations, input.scope),
    )).returning();
    if (!claimed) throw new ToolPolicyError('TOOL_PERMIT_ALREADY_CONSUMED', 'Permit is invalid or already consumed');
    if (
      valueHash(claimed.resource) !== permit.resourceHash ||
      (claimed.approvalDecisionId ?? undefined) !== permit.approvalDecisionId
    ) {
      throw new ToolPolicyError('TOOL_PERMIT_CLAIMS_MISMATCH', 'Permit resource or approval binding is invalid');
    }
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
      content: {
        text: input.result,
        envelopes: [{
          envelopeId: 'tool-result-' + invocation.id,
          tenantId: input.scope.tenantId,
          applicationId: input.scope.applicationId,
          sourceType: 'TOOL',
          sourceId: invocation.toolId + '@' + invocation.toolVersion,
          trustLevel: 'UNTRUSTED',
          instructionCapability: 'FORBIDDEN',
          sensitivityLabels: [],
          contentHash: contextContentHash(input.result),
          parentEnvelopeIds: invocation.supportingEnvelopeIds ?? [],
          policyVersion: bundle.id,
          eventSeq: 0,
          contentStart: 0,
          contentEnd: input.result.length,
        }],
      },
    });
    const blocked = !['ALLOW', 'WARN'].includes(decision.action);
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
