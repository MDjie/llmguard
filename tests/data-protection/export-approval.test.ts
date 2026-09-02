import { describe, expect, it } from 'vitest';
import { exportApprovalRequired, exportQueryHash } from '../../src/lib/data-protection/export-approval';

describe('export approval policy', () => {
  it('is mandatory by default in production and optional in development', () => {
    expect(exportApprovalRequired({ NODE_ENV: 'production' })).toBe(true);
    expect(exportApprovalRequired({ NODE_ENV: 'development' })).toBe(false);
    expect(exportApprovalRequired({ NODE_ENV: 'production', EXPORT_APPROVAL_REQUIRED: 'false' })).toBe(false);
  });

  it('binds approval to a canonical export query', () => {
    const left = exportQueryHash({ format: 'csv', action: 'block', startDate: '2026-01-01' });
    const same = exportQueryHash({ startDate: '2026-01-01', action: 'block', format: 'csv' });
    const different = exportQueryHash({ format: 'csv', action: 'warn', startDate: '2026-01-01' });
    expect(left).toBe(same);
    expect(left).not.toBe(different);
  });
});
