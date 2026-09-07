import { and, desc, eq, gt, gte, lt, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiProblem } from '@/lib/api-security';
import { archiveQuerySchema, archiveListSchema, archiveMessagesSchema } from '@/contracts/http/conversation-archive';
import { db } from '@/storage/database/shared/db';
import { archivedContentObjects, conversationArchives } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { cursorBinding, decodeConsoleCursor, encodeConsoleCursor } from '@/lib/gateway-runtime/console-cursor';
type Query = z.infer<typeof archiveQuerySchema>;
function windowFor(scope: TenantScope, query: Query, api: string, conversationId?: string) {
  const now = new Date(), { cursor: encoded, limit: _limit, ...filters } = query;
  const binding = cursorBinding(scope, { api, conversationId, ...filters }), cursor = decodeConsoleCursor(encoded, binding, 'LIST', now);
  const watermark = cursor?.watermark ?? now.toISOString(), from = cursor?.from ?? query.from ?? new Date(now.getTime() - query.days * 86400000).toISOString(), to = cursor?.to ?? query.to ?? watermark;
  if (Date.parse(from) >= Date.parse(to) || Date.parse(from) < Date.parse(watermark) - 180 * 86400000 || Date.parse(to) > Date.parse(watermark)) throw new ApiProblem({ status: 400, code: 'ARCHIVE_TIME_RANGE_INVALID', title: 'Invalid archive range', detail: 'Choose a range inside the last 180 days.' });
  return { now, binding, cursor, watermark, from, to };
}
function available(scope: TenantScope, query: Query, window: ReturnType<typeof windowFor>) {
  return and(scopePredicate(conversationArchives, scope), gte(conversationArchives.acceptedAt, new Date(window.from)), lte(conversationArchives.acceptedAt, new Date(window.to)),
    or(gte(conversationArchives.expiresAt, window.now), gt(conversationArchives.holdUntil, window.now)),
    query.requestId ? eq(conversationArchives.requestId, query.requestId) : undefined, query.sessionId ? eq(conversationArchives.conversationId, query.sessionId) : undefined);
}
export async function listConversationArchives(scope: TenantScope, query: Query) {
  const window = windowFor(scope, query, 'archive-requests'), position = window.cursor?.position;
  const time = sql`date_trunc('milliseconds', ${conversationArchives.acceptedAt} AT TIME ZONE 'UTC')`;
  const rows = await db.select().from(conversationArchives).where(and(available(scope, query, window),
    position ? or(lt(time, position.time), and(eq(time, position.time), lt(conversationArchives.requestId, position.id))) : undefined))
    .orderBy(desc(time), desc(conversationArchives.requestId)).limit(query.limit + 1);
  const hasMore = rows.length > query.limit, selected = rows.slice(0, query.limit), last = selected.at(-1);
  return archiveListSchema.parse({ items: selected.map(row => ({ requestId: row.requestId, conversationId: row.conversationId, subjectId: row.subjectId, state: row.state,
    acceptedAt: row.acceptedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), holdUntil: row.holdUntil?.toISOString() ?? null, integrity: row.integrity,
    modelOutputFinalSequence: row.modelOutputFinalSequence, modelOutputUnavailableReason: row.modelOutputUnavailableReason })),
    from: window.from, to: window.to, watermark: window.watermark, hasMore, nextCursor: hasMore && last ? encodeConsoleCursor({ kind: 'LIST', binding: window.binding, watermark: window.watermark,
      from: window.from, to: window.to, position: { time: last.acceptedAt.toISOString(), id: last.requestId } }) : null });
}
export async function listArchivedMessages(scope: TenantScope, conversationId: string, query: Query) {
  const window = windowFor(scope, query, 'archive-messages', conversationId), position = window.cursor?.position;
  const time = sql`date_trunc('milliseconds', ${archivedContentObjects.createdAt} AT TIME ZONE 'UTC')`;
  const rows = await db.select({ id: archivedContentObjects.id, requestId: archivedContentObjects.requestId, purpose: archivedContentObjects.purpose, sequence: archivedContentObjects.sequence,
    representation: archivedContentObjects.representation, state: archivedContentObjects.state, sourceDigest: archivedContentObjects.contentHmac, createdAt: archivedContentObjects.createdAt,
    expiresAt: archivedContentObjects.expiresAt, sourceStepId: archivedContentObjects.sourceStepId, eventSequence: archivedContentObjects.eventSequence, rangeStart: archivedContentObjects.rangeStart, rangeEnd: archivedContentObjects.rangeEnd,
  }).from(archivedContentObjects).innerJoin(conversationArchives, and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, archivedContentObjects.requestId)))
    .where(and(scopePredicate(archivedContentObjects, scope), available(scope, query, window), eq(conversationArchives.conversationId, conversationId), lte(time, window.watermark),
      position ? or(lt(time, position.time), and(eq(time, position.time), lt(archivedContentObjects.id, position.id))) : undefined))
    .orderBy(desc(time), desc(archivedContentObjects.id)).limit(query.limit + 1);
  const hasMore = rows.length > query.limit, selected = rows.slice(0, query.limit), last = selected.at(-1);
  return archiveMessagesSchema.parse({ items: selected.map(row => ({ ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), rawAccess: 'APPROVAL_REQUIRED' })),
    from: window.from, to: window.to, watermark: window.watermark, hasMore, nextCursor: hasMore && last ? encodeConsoleCursor({ kind: 'LIST', binding: window.binding, watermark: window.watermark,
      from: window.from, to: window.to, position: { time: last.createdAt.toISOString(), id: last.id } }) : null });
}
