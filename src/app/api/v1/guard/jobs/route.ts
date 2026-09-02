import { and, desc, eq } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { createGuardJobSchema, guardJobListQuerySchema } from '@/contracts/http/guard-jobs';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { GuardJobError, submitGuardJob } from '@/lib/guard-jobs';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { guardJobs } from '@/storage/database/shared/schema';

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: createGuardJobSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'guard-job.submit',
    rateLimitPolicy: { id: 'guard-job-submit', windowMs: 60_000, maxRequests: 30, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      const submission = await submitGuardJob({
        scope: requireTenantContext(principal), ownerId: principal!.subject, ...body,
      });
      return Response.json({ success: true, data: submission.job, reused: submission.reused },
        { status: submission.reused ? 200 : 202 });
    } catch (error) {
      if (error instanceof GuardJobError) {
        throw new ApiProblem({
          status: error.code === 'GRD_IDEMPOTENCY_CONFLICT' ? 409 : 422,
          code: error.code,
          title: 'Guard job submission rejected',
          detail: error.message,
        });
      }
      throw error;
    }
  },
);

export const GET = withApiSecurity(
  {
    permission: 'guard:use',
    querySchema: guardJobListQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'guard-job.list',
    rateLimitPolicy: { id: 'guard-job-list', windowMs: 60_000, maxRequests: 60, scope: 'application' },
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const conditions = [scopePredicate(guardJobs, scope), eq(guardJobs.ownerId, principal!.subject)];
    if (query.status) conditions.push(eq(guardJobs.status, query.status));
    const jobs = await db.select().from(guardJobs).where(and(...conditions))
      .orderBy(desc(guardJobs.createdAt)).limit(query.limit);
    return Response.json({ success: true, data: jobs });
  },
);
