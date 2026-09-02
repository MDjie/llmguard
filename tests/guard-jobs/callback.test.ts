import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signJobCallback } from '../../src/lib/guard-jobs';

describe('guard job callback signing', () => {
  it('binds timestamp, nonce and exact body hash with HMAC-SHA256', () => {
    const signed = signJobCallback(
      { jobId: 'job-1', status: 'completed' },
      'callback-secret-32-bytes-minimum-value',
      new Date('2026-01-01T00:00:00Z'),
      'nonce-1',
    );
    const bodyHash = createHash('sha256').update(signed.body).digest('hex');
    const expected = createHmac('sha256', 'callback-secret-32-bytes-minimum-value')
      .update(`1767225600.nonce-1.${bodyHash}`).digest('base64url');
    expect(signed.headers).toMatchObject({
      'x-guard-timestamp': '1767225600',
      'x-guard-nonce': 'nonce-1',
      'x-guard-content-sha256': bodyHash,
      'x-guard-signature': `v1=${expected}`,
    });
    expect(signed.body).not.toContain('callback-secret');
  });
});
