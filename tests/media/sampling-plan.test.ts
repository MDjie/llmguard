import { describe, expect, it } from 'vitest';
import { createVideoSamplingPlan } from '../../src/lib/media/sampling-plan';

describe('video sampling plan', () => {
  it('covers boundaries, middle, fixed intervals, scene changes and short flashes within bounds', () => {
    const plan = createVideoSamplingPlan(3_600_000);
    expect(plan.maxFrames).toBe(10_000);
    expect(plan.strategies.map((item) => item.type)).toEqual([
      'boundary', 'midpoint', 'fixed_interval', 'scene_change', 'short_flash',
    ]);
    expect(plan.strategies.find((item) => item.type === 'midpoint')?.parameters.atMs).toBe(1_800_000);
    expect(plan.strategies.find((item) => item.type === 'fixed_interval')?.parameters.intervalMs)
      .toBeGreaterThanOrEqual(1_000);
  });

  it('applies an explicit frame interval and bounded frame budget', () => {
    const plan = createVideoSamplingPlan(60_000, {
      intervalMs: 2_500,
      maxFrames: 24,
    });
    expect(plan.maxFrames).toBe(24);
    expect(plan.strategies.find((item) => item.type === 'fixed_interval')?.parameters.intervalMs)
      .toBe(2_500);
  });
});
