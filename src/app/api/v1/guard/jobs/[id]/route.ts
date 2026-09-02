import { and, asc, eq, inArray } from 'drizzle-orm';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { guardJobParamsSchema } from '@/contracts/http/guard-jobs';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { cancelGuardJob, GuardJobError } from '@/lib/guard-jobs';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { guardJobEvents, guardJobs } from '@/storage/database/shared/schema';

async function ownedJob(scope: ReturnType<typeof requireTenantContext>, ownerId: string, id: string) {
  const [job] = await db.select().from(guardJobs).where(and(
    eq(guardJobs.id, id), eq(guardJobs.ownerId, ownerId), scopePredicate(guardJobs, scope),
  )).limit(1);
  if (!job) throw new ApiProblem({
    status: 404, code: 'GRD_JOB_NOT_FOUND', title: 'Guard job not found',
    detail: 'The job does not exist in the current principal and application scope.',
  });
  return job;
}

export const GET = withApiSecurity(
  {
    permission: 'guard:use', paramsSchema: guardJobParamsSchema, querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0, auditEvent: 'guard-job.read',
    rateLimitPolicy: { id: 'guard-job-read', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ principal, routeContext }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const scope = requireTenantContext(principal);
    const job = await ownedJob(scope, principal!.subject, id);
    const events = await db.select().from(guardJobEvents).where(and(
      eq(guardJobEvents.jobId, id), scopePredicate(guardJobEvents, scope),
    )).orderBy(asc(guardJobEvents.createdAt)).limit(10_000);
    return Response.json({ success: true, data: { ...job, events } });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'guard:use', paramsSchema: guardJobParamsSchema, querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0, auditEvent: 'guard-job.cancel',
    rateLimitPolicy: { id: 'guard-job-cancel', windowMs: 60_000, maxRequests: 30, scope: 'application' },
  },
  async ({ principal, routeContext }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    try {
      const job = await cancelGuardJob(requireTenantContext(principal), principal!.subject, id);
      return Response.json({ success: true, data: job });
    } catch (error) {
      if (error instanceof GuardJobError) {
        throw new ApiProblem({ status: 409, code: error.code, title: 'Job cancellation rejected', detail: error.message });
      }
      throw error;
    }
  },
);
