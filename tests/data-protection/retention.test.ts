import { describe, expect, it } from 'vitest';
import { rawContentRetentionDays, retentionCutoff } from '../../src/lib/data-protection/retention';

describe('raw content retention policy', () => {
  it('defaults to seven days and computes a stable UTC cutoff', () => {
    expect(rawContentRetentionDays({})).toBe(7);
    expect(retentionCutoff(new Date('2026-09-01T00:00:00.000Z'), 7).toISOString())
      .toBe('2026-08-25T00:00:00.000Z');
  });

  it('rejects unsafe retention values', () => {
    expect(() => rawContentRetentionDays({ RAW_CONTENT_RETENTION_DAYS: '0' })).toThrow();
    expect(() => rawContentRetentionDays({ RAW_CONTENT_RETENTION_DAYS: '7.5' })).toThrow();
    expect(() => rawContentRetentionDays({ RAW_CONTENT_RETENTION_DAYS: '9999' })).toThrow();
  });
});
