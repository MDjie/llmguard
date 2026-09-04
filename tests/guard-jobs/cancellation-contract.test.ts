import { describe, expect, it } from 'vitest';
import { GuardJobError, isGuardJobCancellationError } from '../../src/lib/guard-jobs';

describe('guard job cancellation contract', () => {
  it('distinguishes cancellation races from retryable execution failures', () => {
    expect(isGuardJobCancellationError(new GuardJobError(
      'GRD_JOB_CANCELLED_OR_TERMINAL',
      'cancelled',
    ))).toBe(true);
    expect(isGuardJobCancellationError(new Error('ANALYZER_REQUEST_FAILED'))).toBe(false);
  });
});
