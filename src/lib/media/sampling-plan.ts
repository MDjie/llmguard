export interface VideoSamplingPlan {
  readonly strategies: readonly {
    readonly type: 'fixed_interval' | 'scene_change' | 'boundary' | 'midpoint' | 'short_flash';
    readonly parameters: Readonly<Record<string, number>>;
  }[];
  readonly maxFrames: number;
  readonly maxDurationMs: number;
}

export function createVideoSamplingPlan(durationMs: number): VideoSamplingPlan {
  const boundedDuration = Math.max(0, durationMs);
  const intervalMs = Math.max(1_000, Math.ceil(boundedDuration / 1_000));
  return {
    strategies: [
      { type: 'boundary', parameters: { startMs: 0, endMs: boundedDuration } },
      { type: 'midpoint', parameters: { atMs: Math.floor(boundedDuration / 2) } },
      { type: 'fixed_interval', parameters: { intervalMs } },
      { type: 'scene_change', parameters: { threshold: 0.25 } },
      { type: 'short_flash', parameters: { minimumDurationMs: 40, scanFps: 25 } },
    ],
    maxFrames: 10_000,
    maxDurationMs: boundedDuration,
  };
}
