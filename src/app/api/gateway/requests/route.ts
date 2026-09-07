import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { gatewayRequestDetailSchema, gatewayRequestListSchema } from '@/contracts/http/gateway-console';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { gatewayRequests, gatewaySteps, gatewayExecutionEvents, gatewayRequestResources } from '@/storage/database/shared/schema';

const querySchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), state: z.enum(['AUTHORIZED','SEND_INTENT','UPSTREAM_STARTED','RELEASING','WRITTEN','COMPLETED','TERMINATED','REVIEW_REQUIRED','UPSTREAM_OUTCOME_UNKNOWN']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const requestFields = { id: gatewayRequests.id, snapshotId: gatewayRequests.snapshotId, subjectId: gatewayRequests.subjectId, sessionId: gatewayRequests.sessionId,
  state: gatewayRequests.state, preparationState: gatewayRequests.preparationState, stepCount: gatewayRequests.stepCount, lastEventSeq: gatewayRequests.lastEventSeq, sessionFinalized: gatewayRequests.sessionFinalized, createdAt: gatewayRequests.createdAt, expiresAt: gatewayRequests.expiresAt };
export const GET = withApiSecurity({ permission: 'history:read', querySchema, responseSchema:z.union([gatewayRequestDetailSchema,gatewayRequestListSchema]), maxBodyBytes: 0, auditEvent: 'gateway.requests.read',
  rateLimitPolicy: { id: 'gateway-requests-read', windowMs: 60000, maxRequests: 120, scope: 'principal' } }, async ({ principal, query }) => {
  const scope = requireTenantContext(principal);
  const filter = and(scopePredicate(gatewayRequests, scope), query.id ? eq(gatewayRequests.id, query.id) : undefined, query.state ? eq(gatewayRequests.state, query.state) : undefined);
  const requests = await db.select(requestFields).from(gatewayRequests).where(filter).orderBy(desc(gatewayRequests.createdAt)).limit(query.limit);
  if (query.id) {
    const [steps, events] = await Promise.all([
      db.select({ id: gatewaySteps.id, stage: gatewaySteps.stage, streamSeq: gatewaySteps.streamSeq, attemptKind: gatewaySteps.attemptKind, decisionId: gatewaySteps.decisionId,
        action: gatewaySteps.action, coverage: gatewaySteps.coverage, status: gatewaySteps.status, latencyMs: gatewaySteps.latencyMs, modelVersions: gatewaySteps.modelVersions, createdAt: gatewaySteps.createdAt })
        .from(gatewaySteps).where(and(scopePredicate(gatewaySteps, scope), eq(gatewaySteps.requestId, query.id))).orderBy(gatewaySteps.createdAt).limit(512),
      db.select({ sequence: gatewayExecutionEvents.eventSeq, auditBatchId: gatewayExecutionEvents.auditBatchId, kind: gatewayExecutionEvents.kind, stepId: gatewayExecutionEvents.stepId, decisionId: gatewayExecutionEvents.decisionId,
        recheckDecisionId: gatewayExecutionEvents.recheckDecisionId, actualAction: gatewayExecutionEvents.actualAction, reasonCode: gatewayExecutionEvents.reasonCode,
        rangeStart: gatewayExecutionEvents.rangeStart, rangeEnd: gatewayExecutionEvents.rangeEnd, payloadHmac: gatewayExecutionEvents.payloadHmac, createdAt: gatewayExecutionEvents.createdAt })
        .from(gatewayExecutionEvents).where(and(scopePredicate(gatewayExecutionEvents, scope), eq(gatewayExecutionEvents.requestId, query.id))).orderBy(gatewayExecutionEvents.eventSeq).limit(4096),
    ]);
    const [resource] = await db.select().from(gatewayRequestResources).where(and(scopePredicate(gatewayRequestResources, scope), eq(gatewayRequestResources.requestId, query.id))).limit(1);
    const resources = resource ? { state: resource.state, preparedInputChars: resource.preparedInputChars, inspectedChars: resource.inspectedChars, inspectionSteps: resource.inspectionSteps, preparedReferences: resource.preparedReferences,
      admissionHmac: resource.admissionHmac, settlementHmac: resource.settlementHmac, settledAt: resource.settledAt, modelOutcome: typeof resource.settlement?.modelOutcome === 'string' ? resource.settlement.modelOutcome : null } : null;
    return Response.json({ request: requests[0] ?? null, resources, steps, events, writeAcceptedMeaning: '服务器写入确认，不代表客户端收妥' });
  }
  const totals = await db.select({ state: gatewayRequests.state, count: sql<number>`count(*)::int` }).from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), sql`${gatewayRequests.createdAt} >= now() - interval '24 hours'`)).groupBy(gatewayRequests.state);
  return Response.json({ items: requests, totals, timeRange: '24h', limit: query.limit });
});
