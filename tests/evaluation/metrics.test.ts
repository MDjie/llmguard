import { describe, expect, it } from 'vitest';
import { calculateEvaluationMetrics } from '../../src/lib/evaluation/metrics';

describe('evaluation metrics', () => {
  it('calculates confusion matrix, quality and nearest-rank latency percentiles', () => {
    const metrics = calculateEvaluationMetrics([
      { expectedAction: 'BLOCK', actualAction: 'BLOCK', latencyMs: 10 },
      { expectedAction: 'ALLOW', actualAction: 'ALLOW', latencyMs: 20 },
      { expectedAction: 'ALLOW', actualAction: 'WARN', latencyMs: 30 },
      { expectedAction: 'BLOCK', actualAction: 'ALLOW', latencyMs: 40 },
    ]);
    expect(metrics.confusionMatrix).toEqual({
      truePositive: 1,
      trueNegative: 1,
      falsePositive: 1,
      falseNegative: 1,
    });
    expect(metrics).toMatchObject({
      accuracy: 0.5,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      falsePositiveRate: 0.5,
      falseNegativeRate: 0.5,
      latencyMs: { p50: 20, p95: 40, p99: 40, max: 40 },
    });
  });

  it('returns finite zero rates for an empty dataset', () => {
    expect(calculateEvaluationMetrics([])).toMatchObject({
      accuracy: 0,
      precision: 0,
      recall: 0,
      f1: 0,
    });
  });
});
