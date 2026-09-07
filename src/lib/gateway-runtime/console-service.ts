import { ApiProblem } from '@/lib/api-security';
import { and, asc, desc, eq, sql, gt, gte, lt, lte, or } from 'drizzle-orm';
import type { GatewayConsoleQuery } from '@/contracts/http/gateway-console';
import { cursorBinding, decodeConsoleCursor, encodeConsoleCursor, eventSequenceGaps } from './console-cursor';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { gatewayRequests, gatewaySteps, gatewayExecutionEvents, gatewayRequestResources } from '@/storage/database/shared/schema';
const queryProblem = (code: string, status: number) => new ApiProblem({ status, code, title: 'Request cannot be completed', detail: code });
const requestFields = { id: gatewayRequests.id, snapshotId: gatewayRequests.snapshotId, subjectId: gatewayRequests.subjectId, sessionId: gatewayRequests.sessionId,
  state: gatewayRequests.state, preparationState: gatewayRequests.preparationState, stepCount: gatewayRequests.stepCount, lastEventSeq: gatewayRequests.lastEventSeq, sessionFinalized: gatewayRequests.sessionFinalized, createdAt: gatewayRequests.createdAt, expiresAt: gatewayRequests.expiresAt };

export async function readGatewayRequests(scope: TenantScope, query: GatewayConsoleQuery) {
  const now = new Date(), binding = cursorBinding(scope, { id: query.id, state: query.state, from: query.from, to: query.to });
  const cursor = decodeConsoleCursor(query.cursor, binding, query.id ? 'DETAIL' : 'LIST', now);
  const watermark = cursor?.watermark ?? now.toISOString();
  const from = cursor?.from ?? query.from ?? new Date(now.getTime() - 86400000).toISOString(), to = cursor?.to ?? query.to ?? watermark;
  if (!query.id && (Date.parse(from) >= Date.parse(to) || Date.parse(from) < Date.parse(watermark) - 180 * 86400000 || Date.parse(to) > Date.parse(watermark))) throw queryProblem('TRACE_TIME_RANGE_INVALID', 400);
  const requestTime = sql`date_trunc('milliseconds', ${gatewayRequests.createdAt} AT TIME ZONE 'UTC')`, stepTime = sql`date_trunc('milliseconds', ${gatewaySteps.createdAt} AT TIME ZONE 'UTC')`;
  const listFilter = and(scopePredicate(gatewayRequests, scope), gte(requestTime, from), lte(requestTime, to), query.state ? eq(gatewayRequests.state, query.state) : undefined);
  const filter = query.id ? and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, query.id)) : and(listFilter,
    cursor?.position ? or(lt(requestTime, cursor.position.time), and(eq(requestTime, cursor.position.time), lt(gatewayRequests.id, cursor.position.id))) : undefined);
  const requests = await db.select(requestFields).from(gatewayRequests).where(filter).orderBy(desc(requestTime), desc(gatewayRequests.id)).limit(query.id ? 1 : query.limit + 1);
  if (query.id) {
    if (!requests[0]) throw queryProblem('GATEWAY_REQUEST_NOT_FOUND', 404);
    const eventWatermark = cursor?.eventWatermark ?? requests[0].lastEventSeq, lastEvent = cursor?.lastEvent ?? 0;
    if (eventWatermark > requests[0].lastEventSeq) throw queryProblem('TRACE_CURSOR_INVALID', 400);
    const [steps, events] = await Promise.all([
      db.select({ id: gatewaySteps.id, stage: gatewaySteps.stage, streamSeq: gatewaySteps.streamSeq, attemptKind: gatewaySteps.attemptKind, decisionId: gatewaySteps.decisionId,
        action: gatewaySteps.action, coverage: gatewaySteps.coverage, status: gatewaySteps.status, latencyMs: gatewaySteps.latencyMs, modelVersions: gatewaySteps.modelVersions, createdAt: gatewaySteps.createdAt })
        .from(gatewaySteps).where(and(scopePredicate(gatewaySteps, scope), eq(gatewaySteps.requestId, query.id), lte(stepTime, watermark), cursor?.position ? or(gt(stepTime, cursor.position.time), and(eq(stepTime, cursor.position.time), gt(gatewaySteps.id, cursor.position.id))) : undefined)).orderBy(asc(stepTime), asc(gatewaySteps.id)).limit(query.limit + 1),
      db.select({ sequence: gatewayExecutionEvents.eventSeq, auditBatchId: gatewayExecutionEvents.auditBatchId, kind: gatewayExecutionEvents.kind, stepId: gatewayExecutionEvents.stepId, decisionId: gatewayExecutionEvents.decisionId,
        recheckDecisionId: gatewayExecutionEvents.recheckDecisionId, actualAction: gatewayExecutionEvents.actualAction, reasonCode: gatewayExecutionEvents.reasonCode,
        rangeStart: gatewayExecutionEvents.rangeStart, rangeEnd: gatewayExecutionEvents.rangeEnd, payloadHmac: gatewayExecutionEvents.payloadHmac, createdAt: gatewayExecutionEvents.createdAt })
        .from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, scope), eq(gatewayExecutionEvents.requestId, query.id), gt(gatewayExecutionEvents.eventSeq, lastEvent), lte(gatewayExecutionEvents.eventSeq, eventWatermark))).orderBy(gatewayExecutionEvents.eventSeq).limit(query.limit + 1),
    ]);
    const [resource] = await db.select().from(gatewayRequestResources).where(and(scopePredicate(gatewayRequestResources, scope), eq(gatewayRequestResources.requestId, query.id))).limit(1);
    const resources = resource ? { state: resource.state, preparedInputChars: resource.preparedInputChars, inspectedChars: resource.inspectedChars, inspectionSteps: resource.inspectionSteps, preparedReferences: resource.preparedReferences,
      admissionHmac: resource.admissionHmac, settlementHmac: resource.settlementHmac, settledAt: resource.settledAt, modelOutcome: typeof resource.settlement?.modelOutcome === 'string' ? resource.settlement.modelOutcome : null } : null;
    const stepsHaveMore = steps.length > query.limit, eventsHaveMore = events.length > query.limit, hasMore = stepsHaveMore || eventsHaveMore;
    const stepPage = steps.slice(0, query.limit), eventPage = events.slice(0, query.limit), lastStep = stepPage.at(-1);
    const nextCursor = hasMore ? encodeConsoleCursor({ kind: 'DETAIL', binding, watermark, eventWatermark,
      position: lastStep ? { time: lastStep.createdAt.toISOString(), id: lastStep.id } : cursor?.position,
      lastEvent: eventPage.at(-1)?.sequence ?? lastEvent }) : null;
    return { request: requests[0], resources, steps: stepPage, events: eventPage,
      pagination: { nextCursor, hasMore, watermark, eventWatermark, stepsHaveMore, eventsHaveMore, eventGaps: eventSequenceGaps(eventPage.map(event => event.sequence), lastEvent, eventWatermark, eventsHaveMore) }, writeAcceptedMeaning: '服务器写入确认，不代表客户端收妥' };
  }
  const totals = await db.select({ state: gatewayRequests.state, count: sql<number>`count(*)::int` }).from(gatewayRequests).where(listFilter).groupBy(gatewayRequests.state);
  const hasMore = requests.length > query.limit, items = requests.slice(0, query.limit), last = items.at(-1);
  return { items, totals, from, to, timeRange: query.from || query.to ? 'custom' : '24h', limit: query.limit, hasMore,
    nextCursor: hasMore && last ? encodeConsoleCursor({ kind: 'LIST', binding, watermark, from, to, position: { time: last.createdAt.toISOString(), id: last.id } }) : null };
}
