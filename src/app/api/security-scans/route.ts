import { and, desc, eq } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  listSecurityScansSchema,
  submitSecurityScanSchema,
} from '@/contracts/http/security-scans';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  SecurityScanSubmissionError,
  submitSecurityScan,
} from '@/lib/security-scanning';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { securityScanTasks } from '@/storage/database/shared/schema';

function submissionProblem(error: SecurityScanSubmissionError): ApiProblem {
  const status = (
    error.code === 'SECURITY_SCANNER_NOT_FOUND' ||
    error.code === 'SECURITY_SCAN_ASSET_NOT_FOUND'
  ) ? 404 : 409;
  return new ApiProblem({
    status,
    code: error.code,
    title: 'Security scan submission rejected',
    detail: error.message,
  });
}

export const POST = withApiSecurity(
  {
    permission: 'security:operate',
    bodySchema: submitSecurityScanSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'security-scan.submit',
    rateLimitPolicy: {
      id: 'security-scan-submit',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'application',
    },
  },
  async ({ body, principal }) => {
    try {
      const submission = await submitSecurityScan({
        scope: requireTenantContext(principal),
        actorId: principal!.subject,
        ...body,
      });
      return Response.json({
        success: true,
        data: submission.task,
        reused: submission.reused,
      }, { status: submission.reused ? 200 : 202 });
    } catch (error) {
      if (error instanceof SecurityScanSubmissionError) throw submissionProblem(error);
      throw error;
    }
  },
);

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    querySchema: listSecurityScansSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'security-scan.list',
    rateLimitPolicy: {
      id: 'security-scan-list',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'application',
    },
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const conditions = [scopePredicate(securityScanTasks, scope)];
    if (query.status) conditions.push(eq(securityScanTasks.status, query.status));
    const tasks = await db.select().from(securityScanTasks)
      .where(and(...conditions))
      .orderBy(desc(securityScanTasks.createdAt))
      .limit(query.limit);
    return Response.json({ success: true, data: tasks });
  },
);
