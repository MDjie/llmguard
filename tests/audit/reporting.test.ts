import { describe, expect, it } from 'vitest';
import { auditPeriodBounds } from '../../src/lib/audit';
import { auditEventsQuerySchema } from '../../src/contracts/http/audit';

describe('audit reporting', () => {
  it('AUD-006 calculates UTC day, week, month and quarter boundaries', () => {
    const anchor = new Date('2026-09-02T14:20:00.000Z');
    expect(auditPeriodBounds('DAY', anchor).from.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(auditPeriodBounds('WEEK', anchor).from.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(auditPeriodBounds('MONTH', anchor).to.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(auditPeriodBounds('QUARTER', anchor)).toMatchObject({
      from: new Date('2026-07-01T00:00:00.000Z'), to: new Date('2026-10-01T00:00:00.000Z'),
    });
  });

  it('AUD-004 rejects inverted ranges and unbounded page sizes', () => {
    expect(auditEventsQuerySchema.safeParse({
      from: '2026-09-03T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z',
    }).success).toBe(false);
    expect(auditEventsQuerySchema.safeParse({ pageSize: 201 }).success).toBe(false);
    expect(auditEventsQuerySchema.parse({ outcome: 'DENIED', traceId: 'trace-1' })).toMatchObject({
      outcome: 'DENIED', traceId: 'trace-1', page: 1, pageSize: 50,
    });
  });
});
