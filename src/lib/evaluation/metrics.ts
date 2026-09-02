import type { GuardAction } from '@guardllm/contracts';

export interface EvaluationMetricInput {
  readonly expectedAction: string;
  readonly actualAction: GuardAction;
  readonly latencyMs: number;
}

function isPositive(action: string): boolean {
  return action.toUpperCase() !== 'ALLOW';
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

export function calculateEvaluationMetrics(items: readonly EvaluationMetricInput[]) {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let exactMatches = 0;
  for (const item of items) {
    const expected = isPositive(item.expectedAction);
    const actual = isPositive(item.actualAction);
    if (item.expectedAction.toUpperCase() === item.actualAction) exactMatches += 1;
    if (expected && actual) truePositive += 1;
    else if (!expected && !actual) trueNegative += 1;
    else if (!expected && actual) falsePositive += 1;
    else falseNegative += 1;
  }
  const safeDivide = (numerator: number, denominator: number) =>
    denominator === 0 ? 0 : numerator / denominator;
  const precision = safeDivide(truePositive, truePositive + falsePositive);
  const recall = safeDivide(truePositive, truePositive + falseNegative);
  const latencies = items.map((item) => item.latencyMs).sort((a, b) => a - b);
  return {
    total: items.length,
    exactMatches,
    confusionMatrix: { truePositive, trueNegative, falsePositive, falseNegative },
    accuracy: safeDivide(exactMatches, items.length),
    precision,
    recall,
    f1: safeDivide(2 * precision * recall, precision + recall),
    falsePositiveRate: safeDivide(falsePositive, falsePositive + trueNegative),
    falseNegativeRate: safeDivide(falseNegative, falseNegative + truePositive),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.at(-1) ?? 0,
    },
  };
}
