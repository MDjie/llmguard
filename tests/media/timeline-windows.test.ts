import { describe, expect, it } from 'vitest';
import { planTimelineWindows } from '../../src/lib/media/timeline-windows';
describe('bounded timeline windows', () => {
  it('does not chain a continuous stream into an unbounded cluster', () => {
    const segments = Array.from({ length: 120 }, (_, i) => ({ text: 'segment-' + i, startMs: i * 1000, endMs: i * 1000 + 500 }));
    const result = planTimelineWindows(segments, { windowMs: 30000 });
    expect(result.complete).toBe(true); expect(result.windows.length).toBeGreaterThan(1);
    expect(result.windows.every(window => window.endMs - window.startMs === 30000 && window.segments.every(segment => segment.startMs >= window.startMs && segment.endMs <= window.endMs))).toBe(true);
    expect(new Set(result.windows.flatMap(window => window.segments)).size).toBe(segments.length);
  });
  it('preserves overlapping boundary evidence and handles sparse or out-of-order media', () => {
    const segments = [{ text: 'right', startMs: 30000, endMs: 30500 }, { text: 'left', startMs: 29000, endMs: 29500 }, { text: 'anchor', startMs: 0, endMs: 1 }, { text: 'tail', startMs: 604000000, endMs: 604000001 }];
    const result = planTimelineWindows(segments, { windowMs: 30000 });
    expect(result.complete).toBe(true);
    expect(result.windows.some(window => window.segments.includes(segments[0]) && window.segments.includes(segments[1]))).toBe(true);
    expect(result.windows.length).toBeLessThan(10);
  });
  it('records limits and invalid timestamps as gaps rather than silently claiming coverage', () => {
    const result = planTimelineWindows([{ text: 'oversized', startMs: 0, endMs: 30001 }, { text: 'invalid', startMs: -1, endMs: 1 }], { windowMs: 30000 });
    expect(result.complete).toBe(false); expect(result.reasonCodes).toEqual(['MEDIA_SEGMENT_EXCEEDS_WINDOW', 'MEDIA_TIMESTAMP_INVALID']);
    const limited = planTimelineWindows(Array.from({ length: 20 }, (_, i) => ({ text: 'x'.repeat(20), startMs: i * 50000, endMs: i * 50000 + 1 })), { windowMs: 30000, maximumWindows: 2 });
    expect(limited.complete).toBe(false); expect(limited.windows.length).toBeLessThanOrEqual(2); expect(limited.reasonCodes).toContain('MEDIA_WINDOW_COUNT_EXCEEDED');
    expect(planTimelineWindows([{ text: 'too long', startMs: 0, endMs: 1 }], { windowMs: 30000, maximumChars: 3 }).reasonCodes).toContain('MEDIA_WINDOW_CONTENT_BUDGET_EXCEEDED');
    expect(() => planTimelineWindows([], { windowMs: 30000, strideMs: 60000 })).toThrow('BUDGET');
  });
});
