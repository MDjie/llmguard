import { sha256 } from '@/lib/gateway-runtime/protocol';
import { canonicalJson } from '@/lib/policy-bundle';
import type { ToolPermit } from './permit';
import { ToolPolicyError } from './policy';

export function assertExecutionClaims(permit: ToolPermit, invocation: {
  id: string; tenantId: string; applicationId: string; principalId: string;
  agentRunId: string | null; toolId: string; toolVersion: string | null; bundleId: string;
  action: string; resource: string; parametersHash: string; actionIntentHash: string | null;
  approvalDecisionId: string | null; executorConfigurationHash: string | null;
  permitExpiresAt: Date | null; actionIntent: Record<string, unknown> | null; compensatesInvocationId?: string | null;
}, principalId: string, parameters: Readonly<Record<string, unknown>>, now = Date.now()): void {
  if (!permit.executorConfigurationHash || !invocation.executorConfigurationHash ||
      permit.executorConfigurationHash !== invocation.executorConfigurationHash ||
      permit.invocationId !== invocation.id || permit.tenantId !== invocation.tenantId ||
      permit.applicationId !== invocation.applicationId || permit.subjectId !== principalId ||
      permit.subjectId !== invocation.principalId || permit.agentRunId !== invocation.agentRunId ||
      permit.toolId !== invocation.toolId || permit.toolVersion !== invocation.toolVersion ||
      permit.bundleId !== invocation.bundleId || permit.action !== invocation.action ||
      permit.resourceHash !== sha256(invocation.resource) || permit.parametersHash !== invocation.parametersHash ||
      permit.parametersHash !== sha256(canonicalJson(parameters)) || permit.actionIntentHash !== invocation.actionIntentHash ||
      !invocation.actionIntent || sha256(canonicalJson(invocation.actionIntent)) !== invocation.actionIntentHash ||
      (permit.compensatesInvocationId ?? null) !== (invocation.compensatesInvocationId ?? null) ||
      (permit.approvalDecisionId ?? null) !== invocation.approvalDecisionId ||
      permit.expiresAt !== invocation.permitExpiresAt?.getTime() || permit.expiresAt <= now) {
    throw new ToolPolicyError('TOOL_PERMIT_CLAIMS_MISMATCH', 'Execution must match all approved permit claims');
  }
}
