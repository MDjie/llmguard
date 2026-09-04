export interface GuardComplexityInput {
  readonly inputTokens: number;
  readonly requestedOutputTokens: number;
  readonly historicalTokens: number;
  readonly ragChunks: number;
  readonly plannedToolCalls: number;
  readonly modalities: number;
  readonly detectorCostUnits: number;
  readonly modelCostMultiplier: number;
  readonly decodingBranches?: number;
  readonly decodingDepth?: number;
  readonly mediaDurationSeconds?: number;
  readonly mediaFrames?: number;
  readonly documentPages?: number;
  readonly judgeCalls?: number;
  readonly decompressedBytes?: number;
}

export interface GuardComplexityEstimate {
  readonly score: number;
  readonly costUnits: number;
  readonly reasonCodes: readonly string[];
}

function bounded(value: number | undefined, field: string): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`GUARD_COMPLEXITY_${field.toUpperCase()}_INVALID`);
  }
  return resolved;
}

export function estimateGuardComplexity(input: GuardComplexityInput): GuardComplexityEstimate {
  const inputTokens = bounded(input.inputTokens, 'inputTokens');
  const requestedOutputTokens = bounded(input.requestedOutputTokens, 'requestedOutputTokens');
  const historicalTokens = bounded(input.historicalTokens, 'historicalTokens');
  const ragChunks = bounded(input.ragChunks, 'ragChunks');
  const plannedToolCalls = bounded(input.plannedToolCalls, 'plannedToolCalls');
  const modalities = bounded(input.modalities, 'modalities');
  const detectorCostUnits = bounded(input.detectorCostUnits, 'detectorCostUnits');
  const decodingBranches = bounded(input.decodingBranches, 'decodingBranches');
  const decodingDepth = bounded(input.decodingDepth, 'decodingDepth');
  const mediaDurationSeconds = bounded(input.mediaDurationSeconds, 'mediaDurationSeconds');
  const mediaFrames = bounded(input.mediaFrames, 'mediaFrames');
  const documentPages = bounded(input.documentPages, 'documentPages');
  const judgeCalls = bounded(input.judgeCalls, 'judgeCalls');
  const decompressedBytes = bounded(input.decompressedBytes, 'decompressedBytes');
  if (!Number.isFinite(input.modelCostMultiplier) || input.modelCostMultiplier < 1) {
    throw new Error('GUARD_COMPLEXITY_MODELCOSTMULTIPLIER_INVALID');
  }
  const tokenUnits = (inputTokens + requestedOutputTokens + historicalTokens) / 1_000;
  const rawCost = (
    tokenUnits + ragChunks * 2 + plannedToolCalls * 5 + modalities * 8 + detectorCostUnits +
    decodingBranches * 1.5 + decodingDepth * 3 + mediaDurationSeconds / 30 +
    mediaFrames * 0.25 + documentPages * 1.5 + judgeCalls * 12 +
    decompressedBytes / (10 * 1_024 * 1_024)
  ) * input.modelCostMultiplier;
  const costUnits = Math.min(1_000_000_000, Math.ceil(rawCost));
  const reasonCodes = [
    ...(inputTokens + historicalTokens > 65_536 ? ['LONG_CONTEXT'] : []),
    ...(ragChunks > 20 ? ['HIGH_RAG_FANOUT'] : []),
    ...(plannedToolCalls > 8 ? ['HIGH_TOOL_FANOUT'] : []),
    ...(modalities > 1 ? ['MULTIMODAL'] : []),
    ...(decodingBranches > 8 ? ['HIGH_DECODING_BRANCHES'] : []),
    ...(decodingDepth > 3 ? ['DEEP_DECODING'] : []),
    ...(mediaDurationSeconds > 3_600 ? ['LONG_MEDIA'] : []),
    ...(mediaFrames > 1_000 ? ['HIGH_FRAME_COUNT'] : []),
    ...(documentPages > 500 ? ['HIGH_PAGE_COUNT'] : []),
    ...(judgeCalls > 4 ? ['HIGH_JUDGE_FANOUT'] : []),
    ...(decompressedBytes > 512 * 1_024 * 1_024 ? ['HIGH_DECOMPRESSION_VOLUME'] : []),
  ];
  return { score: Math.min(100, Math.ceil(Math.log2(costUnits + 1) * 10)), costUnits, reasonCodes };
}
