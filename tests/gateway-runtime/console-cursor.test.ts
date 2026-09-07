import { describe, expect, it } from 'vitest';
import { cursorBinding, decodeConsoleCursor, encodeConsoleCursor, eventSequenceGaps } from '../../src/lib/gateway-runtime/console-cursor';
const now = new Date('2026-09-08T00:00:00Z'), scope = { tenantId: 't', applicationId: 'a' };
describe('complete trace cursors', () => {
  it('binds cursors to scope and filters while accepting omitted optional filters', () => {
    const binding = cursorBinding(scope, { id: 'r', state: undefined });
    const encoded = encodeConsoleCursor({ kind: 'DETAIL', binding, watermark: now.toISOString(), eventWatermark: 12, lastEvent: 8, position: { id: 's', time: now.toISOString() } });
    expect(decodeConsoleCursor(encoded, binding, 'DETAIL', now)?.lastEvent).toBe(8);
    expect(() => decodeConsoleCursor(encoded, cursorBinding({ ...scope, applicationId: 'other' }, { id: 'r' }), 'DETAIL', now)).toThrow('TRACE_CURSOR_INVALID');
    expect(() => decodeConsoleCursor(encoded, binding, 'LIST', now)).toThrow('TRACE_CURSOR_INVALID');
    expect(() => decodeConsoleCursor(encoded, binding, 'DETAIL', new Date(now.getTime() + 3600001))).toThrow('TRACE_CURSOR_INVALID');
  });
  it('reports gaps across pages and at the frozen terminal watermark', () => {
    expect(eventSequenceGaps([1, 2, 4], 0, 10, true)).toEqual([{ from: 3, to: 3 }]);
    expect(eventSequenceGaps([6, 7], 4, 10, false)).toEqual([{ from: 5, to: 5 }, { from: 8, to: 10 }]);
    expect(eventSequenceGaps([], 10, 10, false)).toEqual([]);
  });
});
