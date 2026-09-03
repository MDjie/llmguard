export interface ReleaseHealthSignals {
  readonly errorBudgetHealthy: boolean;
  readonly p99LatencyMs: number;
  readonly maximumP99LatencyMs: number;
  readonly falseNegativeRate: number;
  readonly maximumFalseNegativeRate: number;
  readonly requiredDetectorFailures: number;
  readonly auditDeliveryTerminalFailures: number;
}

export type ReleaseHealthAction =
  | { readonly action: 'CONTINUE'; readonly reasonCodes: readonly [] }
  | { readonly action: 'ROLLBACK'; readonly reasonCodes: readonly string[] };

export function releaseHealthAction(signals: ReleaseHealthSignals): ReleaseHealthAction {
  const values = [
    signals.p99LatencyMs,
    signals.maximumP99LatencyMs,
    signals.falseNegativeRate,
    signals.maximumFalseNegativeRate,
    signals.requiredDetectorFailures,
    signals.auditDeliveryTerminalFailures,
  ];
  if (typeof signals.errorBudgetHealthy !== 'boolean' ||
      values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('RELEASE_HEALTH_SIGNAL_INVALID');
  }
  const reasonCodes = [
    ...(!signals.errorBudgetHealthy ? ['RELEASE_ERROR_BUDGET_EXHAUSTED'] : []),
    ...(signals.p99LatencyMs > signals.maximumP99LatencyMs ? ['RELEASE_P99_EXCEEDED'] : []),
    ...(signals.falseNegativeRate > signals.maximumFalseNegativeRate ? ['RELEASE_FALSE_NEGATIVE_RATE_EXCEEDED'] : []),
    ...(signals.requiredDetectorFailures > 0 ? ['RELEASE_REQUIRED_DETECTOR_FAILED'] : []),
    ...(signals.auditDeliveryTerminalFailures > 0 ? ['RELEASE_AUDIT_DELIVERY_FAILED'] : []),
  ];
  return reasonCodes.length === 0
    ? { action: 'CONTINUE', reasonCodes: [] }
    : { action: 'ROLLBACK', reasonCodes };
}
