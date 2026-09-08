import { and, eq, exists, gte, lt, sql } from 'drizzle-orm';
import type { ExportHistoryQuery } from '@/contracts/http/history';
import { db } from '@/storage/database/shared/db';
import { detectionSessions, detectionRecords, riskFindings } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
export const EXPORT_RECORD_LIMIT = 1000;
export function exportConditions(scope: TenantScope, query: Omit<ExportHistoryQuery, 'format'>) {
  const conditions = [scopePredicate(detectionSessions, scope)];
  if (query.startDate) conditions.push(gte(detectionSessions.createdAt, new Date(`${query.startDate}T00:00:00.000Z`)));
  if (query.endDate) conditions.push(lt(detectionSessions.createdAt, new Date(Date.parse(`${query.endDate}T00:00:00.000Z`) + 86400_000)));
  if (query.action) conditions.push(eq(detectionSessions.finalAction, query.action));
  if (query.riskType) conditions.push(exists(db.select({ id: sql`1` }).from(detectionRecords).innerJoin(riskFindings, eq(riskFindings.recordId, detectionRecords.id)).where(and(
    eq(detectionRecords.sessionId, detectionSessions.id), eq(riskFindings.dimension, query.riskType), scopePredicate(detectionRecords, scope), scopePredicate(riskFindings, scope),
  ))));
  return conditions;
}
