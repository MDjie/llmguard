export interface AgentResourceVector {
  readonly toolSteps: number;
  readonly recursionDepth: number;
  readonly browserTabs: number;
  readonly processes: number;
  readonly connections: number;
  readonly files: number;
  readonly ocrPages: number;
  readonly mediaDurationSeconds: number;
  readonly mediaFrames: number;
  readonly decodingBranches: number;
  readonly judgeCalls: number;
  readonly decompressedBytes: number;
  readonly guardInferenceTokens: number;
}

export type AgentResourceName = keyof AgentResourceVector;

export interface AgentLifecycleBudget {
  readonly limits: AgentResourceVector;
  readonly usage: AgentResourceVector;
}

export type BudgetReservationResult =
  | { readonly allowed: true; readonly budget: AgentLifecycleBudget }
  | {
      readonly allowed: false;
      readonly budget: AgentLifecycleBudget;
      readonly reasonCodes: readonly string[];
      readonly exhaustedResources: readonly AgentResourceName[];
    };

const RESOURCES: readonly AgentResourceName[] = [
  'toolSteps', 'recursionDepth', 'browserTabs', 'processes', 'connections',
  'files', 'ocrPages', 'mediaDurationSeconds', 'mediaFrames', 'decodingBranches',
  'judgeCalls', 'decompressedBytes', 'guardInferenceTokens',
];

function validateVector(vector: AgentResourceVector, prefix: string): void {
  for (const resource of RESOURCES) {
    if (!Number.isSafeInteger(vector[resource]) || vector[resource] < 0) {
      throw new Error(`${prefix}_${resource.toUpperCase()}_INVALID`);
    }
  }
}

export function reserveAgentResources(
  budget: AgentLifecycleBudget,
  requested: AgentResourceVector,
): BudgetReservationResult {
  validateVector(budget.limits, 'AGENT_BUDGET_LIMIT');
  validateVector(budget.usage, 'AGENT_BUDGET_USAGE');
  validateVector(requested, 'AGENT_BUDGET_REQUEST');
  const nextUsage = Object.fromEntries(RESOURCES.map((resource) => [
    resource,
    budget.usage[resource] + requested[resource],
  ])) as unknown as AgentResourceVector;
  const exhaustedResources = RESOURCES.filter((resource) =>
    nextUsage[resource] > budget.limits[resource]);
  if (exhaustedResources.length > 0) {
    return {
      allowed: false,
      budget,
      reasonCodes: exhaustedResources.map((resource) =>
        `AGENT_${resource.replace(/([A-Z])/g, '_$1').toUpperCase()}_BUDGET_EXCEEDED`),
      exhaustedResources,
    };
  }
  return { allowed: true, budget: { limits: budget.limits, usage: nextUsage } };
}
