import { and, asc, eq, inArray } from 'drizzle-orm';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { securityScanParamsSchema } from '@/contracts/http/security-scans';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  securityScanAttempts,
  securityScanFindingReviews,
  securityScanFindings,
  securityScanTasks,
} from '@/storage/database/shared/schema';

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: securityScanParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'security-scan.read',
    rateLimitPolicy: {
      id: 'security-scan-read',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'application',
    },
  },
  async ({ principal, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const [task] = await db.select().from(securityScanTasks).where(and(
      eq(securityScanTasks.id, id),
      scopePredicate(securityScanTasks, scope),
    )).limit(1);
    if (!task) {
      throw new ApiProblem({
        status: 404,
        code: 'SECURITY_SCAN_NOT_FOUND',
        title: 'Security scan not found',
        detail: 'The security scan does not exist in the authenticated scope.',
      });
    }
    const [attempts, findings] = await Promise.all([
      db.select().from(securityScanAttempts).where(and(
        eq(securityScanAttempts.taskId, id),
        scopePredicate(securityScanAttempts, scope),
      )).orderBy(asc(securityScanAttempts.attempt)),
      db.select().from(securityScanFindings).where(and(
        eq(securityScanFindings.taskId, id),
        scopePredicate(securityScanFindings, scope),
      )).orderBy(asc(securityScanFindings.createdAt)),
    ]);
    const findingIds = findings.map((finding) => finding.id);
    const reviews = findingIds.length === 0
      ? []
      : await db.select().from(securityScanFindingReviews).where(and(
        inArray(securityScanFindingReviews.findingId, findingIds),
        scopePredicate(securityScanFindingReviews, scope),
      )).orderBy(asc(securityScanFindingReviews.createdAt));
    return Response.json({ success: true, data: { ...task, attempts, findings, reviews } });
  },
);
