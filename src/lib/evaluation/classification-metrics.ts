export interface ClassificationSample {
  readonly entityType: string;
  readonly expected: boolean;
  readonly actual: boolean;
}

export interface RateWithConfidenceInterval {
  readonly value: number;
  readonly lower95: number;
  readonly upper95: number;
  readonly numerator: number;
  readonly denominator: number;
}

export interface EntityClassificationMetrics {
  readonly entityType: string;
  readonly sampleCount: number;
  readonly confusionMatrix: {
    readonly truePositive: number;
    readonly trueNegative: number;
    readonly falsePositive: number;
    readonly falseNegative: number;
  };
  readonly precision: RateWithConfidenceInterval;
  readonly recall: RateWithConfidenceInterval;
  readonly falsePositiveRate: RateWithConfidenceInterval;
  readonly falseNegativeRate: RateWithConfidenceInterval;
}

const Z_95 = 1.959963984540054;

export function wilson95(numerator: number, denominator: number): RateWithConfidenceInterval {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) ||
      numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new Error('CLASSIFICATION_RATE_INPUT_INVALID');
  }
  if (denominator === 0) {
    return { value: 0, lower95: 0, upper95: 1, numerator, denominator };
  }
  const value = numerator / denominator;
  const zSquared = Z_95 ** 2;
  const denominatorAdjustment = 1 + zSquared / denominator;
  const center = (value + zSquared / (2 * denominator)) / denominatorAdjustment;
  const margin = Z_95 * Math.sqrt(
    (value * (1 - value) + zSquared / (4 * denominator)) / denominator,
  ) / denominatorAdjustment;
  return {
    value,
    lower95: Math.max(0, center - margin),
    upper95: Math.min(1, center + margin),
    numerator,
    denominator,
  };
}

function metricsForType(
  entityType: string,
  samples: readonly ClassificationSample[],
): EntityClassificationMetrics {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const sample of samples) {
    if (sample.expected && sample.actual) truePositive += 1;
    else if (!sample.expected && !sample.actual) trueNegative += 1;
    else if (!sample.expected && sample.actual) falsePositive += 1;
    else falseNegative += 1;
  }
  return {
    entityType,
    sampleCount: samples.length,
    confusionMatrix: { truePositive, trueNegative, falsePositive, falseNegative },
    precision: wilson95(truePositive, truePositive + falsePositive),
    recall: wilson95(truePositive, truePositive + falseNegative),
    falsePositiveRate: wilson95(falsePositive, falsePositive + trueNegative),
    falseNegativeRate: wilson95(falseNegative, falseNegative + truePositive),
  };
}

export function calculatePerEntityClassificationMetrics(
  samples: readonly ClassificationSample[],
): readonly EntityClassificationMetrics[] {
  const grouped = new Map<string, ClassificationSample[]>();
  for (const sample of samples) {
    if (!sample.entityType) throw new Error('CLASSIFICATION_ENTITY_TYPE_REQUIRED');
    const group = grouped.get(sample.entityType) ?? [];
    group.push(sample);
    grouped.set(sample.entityType, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityType, group]) => metricsForType(entityType, group));
}
