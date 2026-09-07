import { ApiProblem } from '@/lib/api-security';
const queryProblem = (code: string, status: number) => new ApiProblem({ status, code, title: 'Request cannot be completed', detail: code });
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TenantScope } from '@/lib/tenancy';
import { canonicalJson } from './protocol';
const point = z.object({ time: z.iso.datetime(), id: z.string().min(1).max(128) }).strict();
const cursorSchema = z.object({ kind: z.enum(['LIST', 'DETAIL']), binding: z.string(), watermark: z.iso.datetime(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), position: point.optional(),
  eventWatermark: z.number().int().nonnegative().optional(), lastEvent: z.number().int().nonnegative().optional(),
}).strict();
export type ConsoleCursor = z.infer<typeof cursorSchema>;
export function cursorBinding(scope: TenantScope, filters: unknown) {
  return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify([scope.tenantId, scope.applicationId, filters])))).digest('hex');
}
export function decodeConsoleCursor(encoded: string | undefined, binding: string, kind: ConsoleCursor['kind'], now: Date): ConsoleCursor | undefined {
  if (!encoded) return undefined;
  try {
    if (encoded.length > 4096) throw new Error('size');
    const value = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    if (value.binding !== binding || value.kind !== kind || Date.parse(value.watermark) > now.getTime() || now.getTime() - Date.parse(value.watermark) > 3600000) throw new Error('binding');
    if (kind === 'DETAIL' && (value.eventWatermark === undefined || value.lastEvent === undefined || value.lastEvent > value.eventWatermark)) throw new Error('event');
    return value;
  } catch { throw queryProblem('TRACE_CURSOR_INVALID', 400); }
}
export const encodeConsoleCursor = (cursor: ConsoleCursor) => Buffer.from(JSON.stringify(cursorSchema.parse(cursor))).toString('base64url');
/** A missing sequence is reported, never replaced with a synthetic execution event. */
export function eventSequenceGaps(sequences: readonly number[], previous: number, watermark: number, hasMore: boolean) {
  const gaps: Array<{ from: number; to: number }> = [];
  let expected = previous + 1;
  for (const sequence of sequences) { if (sequence > expected) gaps.push({ from: expected, to: sequence - 1 }); expected = sequence + 1; }
  if (!hasMore && expected <= watermark) gaps.push({ from: expected, to: watermark });
  return gaps;
}
