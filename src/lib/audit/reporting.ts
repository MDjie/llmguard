import { and, asc, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import type { TenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { securityAuditEvents } from '@/storage/database/shared/schema';

export type AuditReportPeriod = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER';

export interface AuditPeriodBounds {
  readonly from: Date;
  readonly to: Date;
}

export function auditPeriodBounds(period: AuditReportPeriod, anchor = new Date()): AuditPeriodBounds {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const day = anchor.getUTCDate();
  let from: Date;
  let to: Date;
  if (period === 'DAY') {
    from = new Date(Date.UTC(year, month, day));
    to = new Date(Date.UTC(year, month, day + 1));
  } else if (period === 'WEEK') {
    const mondayOffset = (anchor.getUTCDay() + 6) % 7;
    from = new Date(Date.UTC(year, month, day - mondayOffset));
    to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 7));
  } else if (period === 'MONTH') {
    from = new Date(Date.UTC(year, month, 1));
    to = new Date(Date.UTC(year, month + 1, 1));
  } else {
    const quarterMonth = Math.floor(month / 3) * 3;
    from = new Date(Date.UTC(year, quarterMonth, 1));
    to = new Date(Date.UTC(year, quarterMonth + 3, 1));
  }
  return { from, to };
}

export async function listAuditEvents(scope: TenantContext, input: {
  readonly eventPrefix?: string;
  readonly outcome?: 'ALLOWED' | 'DENIED' | 'ERROR';
  readonly status?: number;
  readonly principalId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly pathPrefix?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly offset: number;
}) {
  const conditions = [
    eq(securityAuditEvents.tenantId, scope.tenantId),
    eq(securityAuditEvents.applicationId, scope.applicationId),
  ];
  if (input.eventPrefix) conditions.push(ilike(securityAuditEvents.event, `${input.eventPrefix}%`));
  if (input.outcome) conditions.push(eq(securityAuditEvents.outcome, input.outcome));
  if (input.status !== undefined) conditions.push(eq(securityAuditEvents.status, input.status));
  if (input.principalId) conditions.push(eq(securityAuditEvents.principalId, input.principalId));
  if (input.traceId) conditions.push(eq(securityAuditEvents.traceId, input.traceId));
  if (input.requestId) conditions.push(eq(securityAuditEvents.requestId, input.requestId));
  if (input.pathPrefix) conditions.push(ilike(securityAuditEvents.path, `${input.pathPrefix}%`));
  if (input.from) conditions.push(gte(securityAuditEvents.createdAt, new Date(input.from)));
  if (input.to) conditions.push(lte(securityAuditEvents.createdAt, new Date(input.to)));
  const predicate = and(...conditions);
  const [items, countRows] = await Promise.all([
    db.select().from(securityAuditEvents).where(predicate)
      .orderBy(desc(securityAuditEvents.createdAt), desc(securityAuditEvents.id))
      .limit(input.limit).offset(input.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(securityAuditEvents).where(predicate),
  ]);
  return { items, total: Number(countRows[0]?.count ?? 0) };
}

export async function generateAuditReport(
  scope: TenantContext,
  period: AuditReportPeriod,
  anchor?: string,
) {
  const bounds = auditPeriodBounds(period, anchor ? new Date(anchor) : new Date());
  const predicate = and(
    eq(securityAuditEvents.tenantId, scope.tenantId),
    eq(securityAuditEvents.applicationId, scope.applicationId),
    gte(securityAuditEvents.createdAt, bounds.from),
    sql`${securityAuditEvents.createdAt} < ${bounds.to}`,
  );
  const [summaryRows, outcomeRows, eventRows, statusRows, pathRows] = await Promise.all([
    db.select({
      total: sql<number>`count(*)::int`,
      averageLatencyMs: sql<number>`coalesce(round(avg(${securityAuditEvents.latencyMs}))::int, 0)`,
      maxLatencyMs: sql<number>`coalesce(max(${securityAuditEvents.latencyMs}), 0)::int`,
    }).from(securityAuditEvents).where(predicate),
    db.select({ key: securityAuditEvents.outcome, count: sql<number>`count(*)::int` })
      .from(securityAuditEvents).where(predicate).groupBy(securityAuditEvents.outcome).orderBy(asc(securityAuditEvents.outcome)),
    db.select({ key: securityAuditEvents.event, count: sql<number>`count(*)::int` })
      .from(securityAuditEvents).where(predicate).groupBy(securityAuditEvents.event)
      .orderBy(desc(sql`count(*)`), asc(securityAuditEvents.event)).limit(100),
    db.select({ key: securityAuditEvents.status, count: sql<number>`count(*)::int` })
      .from(securityAuditEvents).where(predicate).groupBy(securityAuditEvents.status).orderBy(asc(securityAuditEvents.status)),
    db.select({ key: securityAuditEvents.path, count: sql<number>`count(*)::int` })
      .from(securityAuditEvents).where(predicate).groupBy(securityAuditEvents.path)
      .orderBy(desc(sql`count(*)`), asc(securityAuditEvents.path)).limit(50),
  ]);
  const total = Number(summaryRows[0]?.total ?? 0);
  const outcomes = Object.fromEntries(outcomeRows.map((row) => [row.key, Number(row.count)]));
  return {
    schemaVersion: '1.0', period,
    from: bounds.from.toISOString(), toExclusive: bounds.to.toISOString(),
    generatedAt: new Date().toISOString(), tenantId: scope.tenantId, applicationId: scope.applicationId,
    summary: {
      total,
      allowed: Number(outcomes.ALLOWED ?? 0),
      denied: Number(outcomes.DENIED ?? 0),
      errors: Number(outcomes.ERROR ?? 0),
      denialRate: total === 0 ? 0 : Number(((Number(outcomes.DENIED ?? 0) / total) * 100).toFixed(4)),
      errorRate: total === 0 ? 0 : Number(((Number(outcomes.ERROR ?? 0) / total) * 100).toFixed(4)),
      averageLatencyMs: Number(summaryRows[0]?.averageLatencyMs ?? 0),
      maxLatencyMs: Number(summaryRows[0]?.maxLatencyMs ?? 0),
    },
    byOutcome: outcomeRows.map((row) => ({ outcome: row.key, count: Number(row.count) })),
    byEvent: eventRows.map((row) => ({ event: row.key, count: Number(row.count) })),
    byStatus: statusRows.map((row) => ({ status: row.key, count: Number(row.count) })),
    topPaths: pathRows.map((row) => ({ path: row.key, count: Number(row.count) })),
  };
}
