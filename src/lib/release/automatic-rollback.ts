export interface ReleaseHealthSignals {
  readonly sampleSize: number;
  readonly minimumSampleSize: number;
  readonly errorBudgetHealthy: boolean;
  readonly errorRate: number;
  readonly maximumErrorRate: number;
  readonly p95LatencyMs: number;
  readonly maximumP95LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly maximumP99LatencyMs: number;
  readonly falsePositiveRate: number;
  readonly maximumFalsePositiveRate: number;
  readonly falseNegativeRate: number;
  readonly maximumFalseNegativeRate: number;
  readonly resourceRejectionRate: number;
  readonly maximumResourceRejectionRate: number;
  readonly requiredDetectorFailures: number;
  readonly auditDeliveryTerminalFailures: number;
}

export type ReleaseHealthAction =
  | { readonly action: 'CONTINUE'; readonly reasonCodes: readonly [] }
  | { readonly action: 'HOLD'; readonly reasonCodes: readonly ['RELEASE_SAMPLE_INSUFFICIENT'] }
  | { readonly action: 'ROLLBACK'; readonly reasonCodes: readonly string[] };

export function releaseHealthAction(signals: ReleaseHealthSignals): ReleaseHealthAction {
  const values = [
    signals.sampleSize,
    signals.minimumSampleSize,
    signals.errorRate,
    signals.maximumErrorRate,
    signals.p95LatencyMs,
    signals.maximumP95LatencyMs,
    signals.p99LatencyMs,
    signals.maximumP99LatencyMs,
    signals.falsePositiveRate,
    signals.maximumFalsePositiveRate,
    signals.falseNegativeRate,
    signals.maximumFalseNegativeRate,
    signals.resourceRejectionRate,
    signals.maximumResourceRejectionRate,
    signals.requiredDetectorFailures,
    signals.auditDeliveryTerminalFailures,
  ];
  if (
    typeof signals.errorBudgetHealthy !== 'boolean' ||
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    !Number.isSafeInteger(signals.sampleSize) ||
    !Number.isSafeInteger(signals.minimumSampleSize) ||
    signals.minimumSampleSize < 1
  ) {
    throw new Error('RELEASE_HEALTH_SIGNAL_INVALID');
  }
  const immediateReasons = [
    ...(!signals.errorBudgetHealthy ? ['RELEASE_ERROR_BUDGET_EXHAUSTED'] : []),
    ...(signals.requiredDetectorFailures > 0 ? ['RELEASE_REQUIRED_DETECTOR_FAILED'] : []),
    ...(signals.auditDeliveryTerminalFailures > 0 ? ['RELEASE_AUDIT_DELIVERY_FAILED'] : []),
  ];
  if (signals.sampleSize < signals.minimumSampleSize && immediateReasons.length === 0) {
    return { action: 'HOLD', reasonCodes: ['RELEASE_SAMPLE_INSUFFICIENT'] };
  }
  // Preserve the stable public reason order while immediate integrity failures
  // still bypass the minimum-sample hold above.
  const reasonCodes = [
    ...(!signals.errorBudgetHealthy ? ['RELEASE_ERROR_BUDGET_EXHAUSTED'] : []),
    ...(signals.errorRate > signals.maximumErrorRate ? ['RELEASE_ERROR_RATE_EXCEEDED'] : []),
    ...(signals.p99LatencyMs > signals.maximumP99LatencyMs ? ['RELEASE_P99_EXCEEDED'] : []),
    ...(signals.p95LatencyMs > signals.maximumP95LatencyMs ? ['RELEASE_P95_EXCEEDED'] : []),
    ...(signals.falseNegativeRate > signals.maximumFalseNegativeRate ? ['RELEASE_FALSE_NEGATIVE_RATE_EXCEEDED'] : []),
    ...(signals.falsePositiveRate > signals.maximumFalsePositiveRate ? ['RELEASE_FALSE_POSITIVE_RATE_EXCEEDED'] : []),
    ...(signals.resourceRejectionRate > signals.maximumResourceRejectionRate ? ['RELEASE_RESOURCE_REJECTION_RATE_EXCEEDED'] : []),
    ...(signals.requiredDetectorFailures > 0 ? ['RELEASE_REQUIRED_DETECTOR_FAILED'] : []),
    ...(signals.auditDeliveryTerminalFailures > 0 ? ['RELEASE_AUDIT_DELIVERY_FAILED'] : []),
  ];
  return reasonCodes.length === 0
    ? { action: 'CONTINUE', reasonCodes: [] }
    : { action: 'ROLLBACK', reasonCodes };
}
