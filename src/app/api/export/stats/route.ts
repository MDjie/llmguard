import { and, count } from 'drizzle-orm';
import { exportStatsQuerySchema, exportStatsResponseSchema } from '@/contracts/http/history';
import { withApiSecurity } from '@/lib/api-security';
import { exportConditions, EXPORT_RECORD_LIMIT } from '@/lib/data-protection/export-query';
import { db } from '@/storage/database/shared/db';
import { detectionSessions } from '@/storage/database/shared/schema';
import { requireTenantContext } from '@/lib/tenancy';
export const GET = withApiSecurity({ permission: 'audit:export', querySchema: exportStatsQuerySchema, responseSchema: exportStatsResponseSchema, maxBodyBytes: 0, auditEvent: 'export.statistics.read', rateLimitPolicy: { id: 'export-statistics-read', windowMs: 60_000, maxRequests: 60, scope: 'principal' } }, async ({ query, principal }) => {
  // Numeric days retained for API compatibility; explicit dates take priority.
  const effective = { ...query };
  if (!effective.startDate && effective.days) {
    const now = new Date(); now.setUTCHours(0, 0, 0, 0); now.setUTCDate(now.getUTCDate() - effective.days + 1);
    effective.startDate = now.toISOString().slice(0, 10);
    effective.endDate ??= new Date().toISOString().slice(0, 10);
  }
  const [stats] = await db.select({ totalRecords: count() }).from(detectionSessions).where(and(...exportConditions(requireTenantContext(principal), effective)));
  return Response.json({ success: true, data: { totalRecords: Number(stats?.totalRecords ?? 0), exportLimit: EXPORT_RECORD_LIMIT, dateRange: `${effective.startDate ?? '全部'} — ${effective.endDate ?? '全部'}` } });
});
