import { describe, expect, it } from 'vitest';
import { createGuardJobSchema } from '../../src/contracts/http/guard-jobs';

describe('generated-content media pipeline', () => {
  it('exposes an explicit asynchronous content-mark job type', () => {
    const parsed = createGuardJobSchema.parse({
      artifactId: 'artifact-1',
      bundleId: 'bundle-1',
      jobType: 'content_mark',
      idempotencyKey: 'mark-request-1',
      maxAttempts: 3,
    });
    expect(parsed.jobType).toBe('content_mark');
  });
});
