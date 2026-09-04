export interface MultimodalDetectionPolicy {
  readonly frameBatchSize: number;
  readonly frameIntervalMs?: number;
  readonly maxFrames: number;
  readonly summaryFrames: number;
  readonly maxDurationMs: number;
  readonly maxPixels: number;
  readonly maxDecodedBytes: number;
  readonly maxDecompressionRatio: number;
  readonly minimumConfidence: number;
  readonly reviewThreshold: number;
  readonly blockThreshold: number;
  readonly crossModalWindowMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function numberSetting(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const raw = environment[name];
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${minimum} and ${maximum}`);
  }
  return value;
}

export function loadMultimodalDetectionPolicy(
  environment: Environment = process.env,
): MultimodalDetectionPolicy {
  const intervalText = environment.MULTIMODAL_FRAME_INTERVAL_MS?.trim();
  const reviewThreshold = numberSetting(
    environment, 'MULTIMODAL_REVIEW_THRESHOLD', 0.65, 0, 1,
  );
  const blockThreshold = numberSetting(
    environment, 'MULTIMODAL_BLOCK_THRESHOLD', 0.8, 0, 1,
  );
  if (reviewThreshold > blockThreshold) {
    throw new Error('MULTIMODAL_REVIEW_THRESHOLD must not exceed MULTIMODAL_BLOCK_THRESHOLD');
  }
  return {
    frameBatchSize: numberSetting(
      environment, 'MULTIMODAL_FRAME_BATCH_SIZE', 4, 1, 64, true,
    ),
    ...(intervalText
      ? {
          frameIntervalMs: numberSetting(
            environment, 'MULTIMODAL_FRAME_INTERVAL_MS', 1_000, 40, 3_600_000, true,
          ),
        }
      : {}),
    maxFrames: numberSetting(
      environment, 'MULTIMODAL_MAX_FRAMES', 10_000, 1, 10_000, true,
    ),
    summaryFrames: numberSetting(
      environment, 'MULTIMODAL_SUMMARY_FRAMES', 24, 1, 256, true,
    ),
    maxDurationMs: numberSetting(
      environment, 'MULTIMODAL_MAX_DURATION_MS', 3_600_000, 1_000, 24 * 60 * 60 * 1_000, true,
    ),
    maxPixels: numberSetting(
      environment, 'MULTIMODAL_MAX_PIXELS', 100_000_000, 1, 500_000_000, true,
    ),
    maxDecodedBytes: numberSetting(
      environment, 'MULTIMODAL_MAX_DECODED_BYTES', 2 * 1_024 * 1_024 * 1_024, 1_024, 50 * 1_024 * 1_024 * 1_024, true,
    ),
    maxDecompressionRatio: numberSetting(
      environment, 'MULTIMODAL_MAX_DECOMPRESSION_RATIO', 100, 1, 1_000, true,
    ),
    minimumConfidence: numberSetting(
      environment, 'MULTIMODAL_MIN_CONFIDENCE', 0.35, 0, 1,
    ),
    reviewThreshold,
    blockThreshold,
    crossModalWindowMs: numberSetting(
      environment, 'MULTIMODAL_CROSS_MODAL_WINDOW_MS', 30_000, 1_000, 300_000, true,
    ),
  };
}
