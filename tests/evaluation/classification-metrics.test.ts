import { describe, expect, it } from 'vitest';
import {
  calculatePerEntityClassificationMetrics,
  wilson95,
} from '../../src/lib/evaluation';

describe('per-entity classification metrics', () => {
  it('reports independent confusion rates with Wilson 95 percent intervals', () => {
    const [metrics] = calculatePerEntityClassificationMetrics([
      { entityType: 'pii.email', expected: true, actual: true },
      { entityType: 'pii.email', expected: true, actual: false },
      { entityType: 'pii.email', expected: false, actual: true },
      { entityType: 'pii.email', expected: false, actual: false },
    ]);
    expect(metrics.confusionMatrix).toEqual({
      truePositive: 1, trueNegative: 1, falsePositive: 1, falseNegative: 1,
    });
    expect(metrics.precision.value).toBe(0.5);
    expect(metrics.recall.value).toBe(0.5);
    expect(metrics.falsePositiveRate.value).toBe(0.5);
    expect(metrics.falseNegativeRate.value).toBe(0.5);
    expect(metrics.recall.lower95).toBeLessThan(0.5);
    expect(metrics.recall.upper95).toBeGreaterThan(0.5);
  });

  it('does not turn a zero denominator into a false accuracy claim', () => {
    expect(wilson95(0, 0)).toEqual({
      value: 0, lower95: 0, upper95: 1, numerator: 0, denominator: 0,
    });
  });
});
