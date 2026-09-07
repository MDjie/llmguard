import { ApiProblem } from '@/lib/api-security';
const queryProblem = (code: string, status: number) => new ApiProblem({ status, code, title: 'Request cannot be completed', detail: code });
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, lte, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { decisionRecordOutbox, securityAlerts, gatewayRequests, securityIncidents, incidentTransitions } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope, type TenantContext } from '@/lib/tenancy';
import { alertListSchema, alertViewSchema, decisionRecordedSchema, type AlertQuery, type DecisionRecorded } from '@/contracts/http/security-alerts';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import { buildIncidentPersistenceRecords } from '@/lib/incidents/service';
import { groupAlertFindings, recordIdentity } from './record';
import { projectionFailureCode } from './projection-errors';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex');
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function enqueueDecisionRecord(transaction: Transaction, scope: TenantScope, raw: DecisionRecorded) {
  const payload = decisionRecordedSchema.parse(raw);
  if (!payload.findings.length) return;
  const id = recordIdentity(scope, payload), payloadDigest = hash(payload);
  const inserted = await transaction.insert(decisionRecordOutbox).values({ ...scope, id, payload, payloadDigest }).onConflictDoNothing().returning({ id: decisionRecordOutbox.id });
  if (!inserted.length) {
    const [existing] = await transaction.select().from(decisionRecordOutbox).where(and(scopePredicate(decisionRecordOutbox, scope), eq(decisionRecordOutbox.id, id))).limit(1);
    if (!existing || existing.payloadDigest !== payloadDigest) throw new Error('DECISION_RECORD_IDENTITY_CONFLICT');
  }
}

export async function projectSecurityAlerts(maximum = 100) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error('ALERT_PROJECTION_LIMIT_INVALID');
  return db.transaction(async transaction => {
    const records = await transaction.select().from(decisionRecordOutbox).where(eq(decisionRecordOutbox.state, 'PENDING')).orderBy(asc(decisionRecordOutbox.createdAt), asc(decisionRecordOutbox.id)).limit(maximum).for('update', { skipLocked: true });
    let processed = 0, quarantined = 0;
    for (const row of records) {
      try { await transaction.transaction(async projection => {
      const payload = decisionRecordedSchema.parse(row.payload);
      if (hash(payload) !== row.payloadDigest || recordIdentity(row, payload) !== row.id) throw new Error('DECISION_RECORD_INTEGRITY_FAILED');
      for (const [groupId, finding] of groupAlertFindings(payload)) {
        await projection.insert(securityAlerts).values({ tenantId: row.tenantId, applicationId: row.applicationId, id: hash([row.id, groupId]), recordId: row.id,
          source: payload.source, sourceId: payload.sourceId, requestId: payload.requestId, jobId: payload.jobId, traceId: payload.traceId, sessionId: payload.sessionId,
          decisionId: payload.decisionId, bundleId: payload.bundleId, stage: payload.stage, riskId: finding.riskId, category: finding.category,
          reasonCodes: [...new Set(payload.findings.filter(item => item.riskId === finding.riskId && item.category === finding.category).map(item => item.reasonCode))],
          action: payload.action, score: Math.round(finding.score * 100), evidence: finding.evidence, coverage: payload.coverage, occurredAt: new Date(payload.occurredAt),
        }).onConflictDoNothing();
      }
      await projection.update(decisionRecordOutbox).set({ state: 'PROJECTED', projectedAt: new Date() }).where(eq(decisionRecordOutbox.id, row.id));
      }); processed++; } catch (error: unknown) {
        const failureCode = projectionFailureCode(error);
        // Only proven record failures are isolated. Storage/transaction faults roll back the batch for retry.
        if (!failureCode) throw error;
        await transaction.update(decisionRecordOutbox).set({ state: 'FAILED', failureCode, failedAt: new Date() }).where(and(scopePredicate(decisionRecordOutbox,row),eq(decisionRecordOutbox.id,row.id)));
        quarantined++;
      }
    }
    return { processed, quarantined };
  });
}
const cursorSchema = z.object({ watermark: z.iso.datetime(), from: z.iso.datetime(), to: z.iso.datetime(), time: z.iso.datetime(), id: z.string().regex(/^[a-f0-9]{64}$/), filter: z.string() }).strict();
const fields = { id: securityAlerts.id, source: securityAlerts.source, sourceId: securityAlerts.sourceId, requestId: securityAlerts.requestId, jobId: securityAlerts.jobId,
  traceId: securityAlerts.traceId, sessionId: securityAlerts.sessionId, decisionId: securityAlerts.decisionId, bundleId: securityAlerts.bundleId,
  riskId: securityAlerts.riskId, category: securityAlerts.category, stage: securityAlerts.stage, action: securityAlerts.action, score: securityAlerts.score,
  reasonCodes: securityAlerts.reasonCodes, evidence: securityAlerts.evidence, coverage: securityAlerts.coverage, incidentId: securityAlerts.incidentId, occurredAt: securityAlerts.occurredAt, createdAt: securityAlerts.createdAt,
  actualOutcome: gatewayRequests.state };
function selectAlerts(scope: TenantScope) {
  return db.select(fields).from(securityAlerts).leftJoin(gatewayRequests, and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, securityAlerts.requestId)));
}
function view(row: Awaited<ReturnType<ReturnType<typeof selectAlerts>['execute']>>[number]) {
  return alertViewSchema.parse({ ...row, occurredAt: row.occurredAt.toISOString(), createdAt: row.createdAt.toISOString() });
}
export async function listSecurityAlerts(scope: TenantScope, query: AlertQuery, now = new Date()) {
  const { cursor: encoded, limit, ...filters } = query;
  const filterHash = hash([scope.tenantId, scope.applicationId, filters]);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  try { cursor = encoded ? cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))) : undefined; } catch { throw queryProblem('ALERT_CURSOR_INVALID', 400); }
  if (cursor && cursor.filter !== filterHash) throw queryProblem('ALERT_CURSOR_FILTER_MISMATCH', 400);
  const watermark = cursor?.watermark ?? now.toISOString(), from = cursor?.from ?? query.from ?? new Date(now.getTime() - (query.days ?? 1) * 86400000).toISOString(), to = cursor?.to ?? query.to ?? watermark;
  if (Date.parse(from) >= Date.parse(to) || Date.parse(to) > now.getTime() || Date.parse(from) < Date.parse(watermark) - 180 * 86400000 || Date.parse(watermark) > now.getTime() || now.getTime() - Date.parse(watermark) > 3600000) throw queryProblem('ALERT_TIME_RANGE_INVALID', 400);
  const rows = await selectAlerts(scope).where(and(scopePredicate(securityAlerts, scope), gte(securityAlerts.occurredAt, new Date(from)), lte(securityAlerts.occurredAt, new Date(to)), lte(securityAlerts.createdAt, new Date(watermark)),
    query.action ? eq(securityAlerts.action, query.action) : undefined, query.category ? eq(securityAlerts.category, query.category) : undefined,
    query.riskId ? eq(securityAlerts.riskId, query.riskId) : undefined, query.requestId ? eq(securityAlerts.requestId, query.requestId) : undefined,
    query.sessionId ? eq(securityAlerts.sessionId, query.sessionId) : undefined, query.stage ? eq(securityAlerts.stage, query.stage) : undefined,
    cursor ? or(lt(securityAlerts.occurredAt, new Date(cursor.time)), and(eq(securityAlerts.occurredAt, new Date(cursor.time)), lt(securityAlerts.id, cursor.id))) : undefined,
  )).orderBy(desc(securityAlerts.occurredAt), desc(securityAlerts.id)).limit(limit + 1);
  const hasMore = rows.length > limit, items = rows.slice(0, limit).map(view), last = items.at(-1);
  return alertListSchema.parse({ items, hasMore, watermark, from, to,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ watermark, from, to, time: last.occurredAt, id: last.id, filter: filterHash })).toString('base64url') : null });
}
export async function readSecurityAlert(scope: TenantScope, id: string) {
  const [row] = await selectAlerts(scope).where(and(scopePredicate(securityAlerts, scope), eq(securityAlerts.id, id))).limit(1);
  return row ? view(row) : null;
}

export async function createAlertIncident(scope: TenantContext, alertId: string) {
  return db.transaction(async transaction => {
    const [alert] = await transaction.select().from(securityAlerts).where(and(scopePredicate(securityAlerts, scope), eq(securityAlerts.id, alertId))).limit(1).for('update');
    if (!alert) throw queryProblem('ALERT_NOT_FOUND', 404);
    if (alert.incidentId) return { incidentId: alert.incidentId, created: false };
    // Different alerts from the same decision serialize before looking for an existing incident.
    const groupKey = JSON.stringify([scope.tenantId, scope.applicationId, alert.sessionId ?? alert.traceId, alert.riskId]);
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${groupKey}, 0))`);
    const [existing] = await transaction.select({ id: securityIncidents.id }).from(securityIncidents).where(and(scopePredicate(securityIncidents, scope),
      eq(securityIncidents.riskType, alert.riskId), alert.sessionId ? eq(securityIncidents.sessionId, alert.sessionId) : eq(securityIncidents.traceId, alert.traceId),
    )).orderBy(desc(securityIncidents.createdAt)).limit(1);
    let incidentId = existing?.id;
    if (!incidentId) {
      const records = buildIncidentPersistenceRecords(scope, {
        title: `安全告警复核：${alert.riskId}`.slice(0, 200), severity: alert.category !== 'SECURITY_RISK' ? 'MEDIUM' : alert.score >= 90 ? 'CRITICAL' : alert.score >= 75 ? 'HIGH' : 'MEDIUM',
        traceId: alert.traceId, sessionId: alert.sessionId ?? undefined, riskType: alert.riskId,
        eventAnalysis: canonicalJson({ alertId: alert.id, category: alert.category, decisionAction: alert.action, source: alert.source }),
        attackTechnique: canonicalJson({ ruleIds: alert.evidence.flatMap(item => item.ruleId ? [item.ruleId] : []) }),
        impact: '检测结果已进入人工复核，实际执行结果以请求事件为准。',
        answerEvidence: canonicalJson({ alertId: alert.id, evidenceIds: alert.evidence.map(item => item.evidenceId) }), slaMinutes: 60,
      });
      await transaction.insert(securityIncidents).values(records.incident);
      await transaction.insert(incidentTransitions).values(records.transition);
      incidentId = records.incident.id;
    }
    await transaction.update(securityAlerts).set({ incidentId }).where(and(scopePredicate(securityAlerts, scope), eq(securityAlerts.id, alertId)));
    return { incidentId, created: !existing };
  });
}
