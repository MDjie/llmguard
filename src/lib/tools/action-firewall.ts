import type { ActionIntent, SideEffect } from '@guardllm/contracts';
import { resourceMatches } from './policy';

export type ActionDisposition = 'ALLOW' | 'REWRITE' | 'REQUIRE_APPROVAL' | 'BLOCK';

export interface ActionFirewallDecision {
  readonly disposition: ActionDisposition;
  readonly reasonCodes: readonly string[];
  readonly riskCost: number;
  readonly attributionStatus: 'NOT_REQUIRED' | 'PENDING_APPROVAL';
  readonly repairSuggestion?: Readonly<Record<string, unknown>>;
}

const riskCost: Readonly<Record<SideEffect, number>> = {
  NONE: 0,
  READ: 5,
  WRITE: 20,
  EXECUTE: 40,
  EXTERNAL_COMMUNICATION: 35,
  FINANCIAL: 50,
  PRIVILEGE_CHANGE: 50,
};

const inherentlyHighRisk = new Set<SideEffect>([
  'WRITE',
  'EXECUTE',
  'EXTERNAL_COMMUNICATION',
  'FINANCIAL',
  'PRIVILEGE_CHANGE',
]);

export function evaluateActionIntent(input: {
  readonly intent: ActionIntent;
  readonly now: number;
  readonly parametersDigest: string;
  readonly principalPermissions: readonly string[];
  readonly tool: {
    readonly name: string;
    readonly sideEffect: SideEffect;
    readonly requiredPermissions: readonly string[];
    readonly allowedDataDestinations: readonly string[];
    readonly highRisk: boolean;
    readonly approvalRequired: boolean;
  };
  readonly action: string;
  readonly resource: string;
  readonly contextTainted: boolean;
}): ActionFirewallDecision {
  const invariantFailures = [
    ...(input.intent.toolName !== input.tool.name ? ['ACTION_INTENT_TOOL_MISMATCH'] : []),
    ...(input.intent.targetResource !== input.resource ? ['ACTION_INTENT_RESOURCE_MISMATCH'] : []),
    ...(input.intent.parametersDigest !== input.parametersDigest ? ['ACTION_INTENT_PARAMETERS_MISMATCH'] : []),
    ...(input.intent.sideEffect !== input.tool.sideEffect ? ['ACTION_INTENT_SIDE_EFFECT_MISMATCH'] : []),
    ...(input.intent.expiresAtEpochMs !== undefined && input.intent.expiresAtEpochMs <= input.now
      ? ['ACTION_INTENT_EXPIRED']
      : []),
  ];
  if (invariantFailures.length > 0) {
    return {
      disposition: 'BLOCK',
      reasonCodes: invariantFailures,
      riskCost: riskCost[input.tool.sideEffect],
      attributionStatus: 'NOT_REQUIRED',
      repairSuggestion: { regenerateActionIntent: true },
    };
  }
  const missingIntentPermissions = input.tool.requiredPermissions.filter(
    (permission) => !input.intent.requiredPermissions.includes(permission),
  );
  const missingPrincipalPermissions = input.intent.requiredPermissions.filter(
    (permission) => !input.principalPermissions.includes(permission),
  );
  if (missingIntentPermissions.length > 0 || missingPrincipalPermissions.length > 0) {
    return {
      disposition: 'BLOCK',
      reasonCodes: ['ACTION_PERMISSION_DENIED'],
      riskCost: riskCost[input.tool.sideEffect],
      attributionStatus: 'NOT_REQUIRED',
      repairSuggestion: {
        requiredPermissions: input.tool.requiredPermissions,
        missingPrincipalPermissions,
      },
    };
  }
  const disallowedDestinations = input.intent.dataDestinations.filter((destination) =>
    !resourceMatches(input.tool.allowedDataDestinations, destination));
  if (disallowedDestinations.length > 0) {
    return {
      disposition: 'REWRITE',
      reasonCodes: ['ACTION_DATA_DESTINATION_DENIED'],
      riskCost: riskCost[input.tool.sideEffect],
      attributionStatus: 'NOT_REQUIRED',
      repairSuggestion: {
        removeDataDestinations: disallowedDestinations,
        allowedDataDestinations: input.tool.allowedDataDestinations,
      },
    };
  }
  const cost = riskCost[input.tool.sideEffect] + (input.contextTainted ? 30 : 0);
  if (cost > input.intent.riskBudget) {
    return {
      disposition: 'BLOCK',
      reasonCodes: ['ACTION_RISK_BUDGET_EXCEEDED'],
      riskCost: cost,
      attributionStatus: 'NOT_REQUIRED',
      repairSuggestion: { requiredRiskBudget: cost, currentRiskBudget: input.intent.riskBudget },
    };
  }
  const highRisk = input.tool.highRisk || inherentlyHighRisk.has(input.tool.sideEffect);
  if (highRisk && input.intent.supportingEnvelopeIds.length === 0) {
    return {
      disposition: 'BLOCK',
      reasonCodes: ['ACTION_SUPPORTING_EVIDENCE_REQUIRED'],
      riskCost: cost,
      attributionStatus: 'NOT_REQUIRED',
      repairSuggestion: { requestTrustedUserConfirmation: true },
    };
  }
  if (input.contextTainted && highRisk) {
    return {
      disposition: 'BLOCK',
      reasonCodes: ['ACTION_TAINTED_CONTEXT_DENIED'],
      riskCost: cost,
      attributionStatus: 'NOT_REQUIRED',
      repairSuggestion: { removeUntrustedContext: true, requestTrustedUserConfirmation: true },
    };
  }
  if (highRisk || input.tool.approvalRequired) {
    return {
      disposition: 'REQUIRE_APPROVAL',
      reasonCodes: ['ACTION_HIGH_RISK_APPROVAL_REQUIRED'],
      riskCost: cost,
      attributionStatus: 'PENDING_APPROVAL',
    };
  }
  return {
    disposition: 'ALLOW',
    reasonCodes: [],
    riskCost: cost,
    attributionStatus: 'NOT_REQUIRED',
  };
}
