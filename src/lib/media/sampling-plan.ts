export interface VideoSamplingPlan {
  readonly strategies: readonly {
    readonly type: 'fixed_interval' | 'scene_change' | 'boundary' | 'midpoint' | 'short_flash';
    readonly parameters: Readonly<Record<string, number>>;
  }[];
  readonly maxFrames: number;
  readonly maxDurationMs: number;
}

export function createVideoSamplingPlan(
  durationMs: number,
  options: { readonly intervalMs?: number; readonly maxFrames?: number } = {},
): VideoSamplingPlan {
  const boundedDuration = Math.max(0, durationMs);
  const maxFrames = Math.min(10_000, Math.max(1, Math.floor(options.maxFrames ?? 10_000)));
  const intervalMs = options.intervalMs === undefined
    ? Math.max(1_000, Math.ceil(boundedDuration / maxFrames))
    : Math.min(3_600_000, Math.max(40, Math.floor(options.intervalMs)));
  return {
    strategies: [
      { type: 'boundary', parameters: { startMs: 0, endMs: boundedDuration } },
      { type: 'midpoint', parameters: { atMs: Math.floor(boundedDuration / 2) } },
      { type: 'fixed_interval', parameters: { intervalMs } },
      { type: 'scene_change', parameters: { threshold: 0.25 } },
      { type: 'short_flash', parameters: { minimumDurationMs: 40, scanFps: 25 } },
    ],
    maxFrames,
    maxDurationMs: boundedDuration,
  };
}
