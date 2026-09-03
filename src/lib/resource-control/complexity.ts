export interface GuardComplexityInput {
  readonly inputTokens: number;
  readonly requestedOutputTokens: number;
  readonly historicalTokens: number;
  readonly ragChunks: number;
  readonly plannedToolCalls: number;
  readonly modalities: number;
  readonly detectorCostUnits: number;
  readonly modelCostMultiplier: number;
}

export interface GuardComplexityEstimate {
  readonly score: number;
  readonly costUnits: number;
  readonly reasonCodes: readonly string[];
}

export function estimateGuardComplexity(input: GuardComplexityInput): GuardComplexityEstimate {
  for (const [field, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`GUARD_COMPLEXITY_${field.toUpperCase()}_INVALID`);
  }
  const tokenUnits = (input.inputTokens + input.requestedOutputTokens + input.historicalTokens) / 1_000;
  const costUnits = Math.ceil((
    tokenUnits + input.ragChunks * 2 + input.plannedToolCalls * 5 +
    input.modalities * 8 + input.detectorCostUnits
  ) * Math.max(1, input.modelCostMultiplier));
  const reasonCodes = [
    ...(input.inputTokens + input.historicalTokens > 65_536 ? ['LONG_CONTEXT'] : []),
    ...(input.ragChunks > 20 ? ['HIGH_RAG_FANOUT'] : []),
    ...(input.plannedToolCalls > 8 ? ['HIGH_TOOL_FANOUT'] : []),
    ...(input.modalities > 1 ? ['MULTIMODAL'] : []),
  ];
  return { score: Math.min(100, Math.ceil(Math.log2(costUnits + 1) * 10)), costUnits, reasonCodes };
}
