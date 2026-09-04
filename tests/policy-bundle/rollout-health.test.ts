import { describe, expect, it } from 'vitest';
import { releaseHealthAction, type ReleaseHealthSignals } from '../../src/lib/release';

const healthy: ReleaseHealthSignals = {
  sampleSize: 2_000,
  minimumSampleSize: 1_000,
  errorBudgetHealthy: true,
  errorRate: 0.002,
  maximumErrorRate: 0.01,
  p95LatencyMs: 180,
  maximumP95LatencyMs: 200,
  p99LatencyMs: 280,
  maximumP99LatencyMs: 300,
  falsePositiveRate: 0.005,
  maximumFalsePositiveRate: 0.01,
  falseNegativeRate: 0.01,
  maximumFalseNegativeRate: 0.02,
  resourceRejectionRate: 0.002,
  maximumResourceRejectionRate: 0.01,
  requiredDetectorFailures: 0,
  auditDeliveryTerminalFailures: 0,
};

describe('automatic policy release health gate', () => {
  it('continues only when every release threshold is healthy', () => {
    expect(releaseHealthAction(healthy)).toEqual({ action: 'CONTINUE', reasonCodes: [] });
  });

  it('holds a statistically insufficient sample without promoting', () => {
    expect(releaseHealthAction({ ...healthy, sampleSize: 999 })).toEqual({
      action: 'HOLD', reasonCodes: ['RELEASE_SAMPLE_INSUFFICIENT'],
    });
  });

  it('stops rollout on FPR, errors, P95 or resource rejection thresholds', () => {
    expect(releaseHealthAction({
      ...healthy,
      errorRate: 0.02,
      p95LatencyMs: 201,
      falsePositiveRate: 0.02,
      resourceRejectionRate: 0.02,
    })).toEqual({
      action: 'ROLLBACK',
      reasonCodes: [
        'RELEASE_ERROR_RATE_EXCEEDED',
        'RELEASE_P95_EXCEEDED',
        'RELEASE_FALSE_POSITIVE_RATE_EXCEEDED',
        'RELEASE_RESOURCE_REJECTION_RATE_EXCEEDED',
      ],
    });
  });

  it('fails immediately on mandatory detector or audit delivery failure', () => {
    expect(releaseHealthAction({
      ...healthy, sampleSize: 0, requiredDetectorFailures: 1, auditDeliveryTerminalFailures: 1,
    })).toMatchObject({ action: 'ROLLBACK' });
  });
});
