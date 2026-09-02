import { and, desc, eq } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  listEvaluationRunsSchema,
  submitEvaluationRunSchema,
} from '@/contracts/http/evaluation-runs';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  EvaluationSubmissionError,
  submitEvaluationRun,
} from '@/lib/evaluation';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { evaluationRuns } from '@/storage/database/shared/schema';

function submissionProblem(error: EvaluationSubmissionError): ApiProblem {
  const status = error.code === 'EVALUATION_CASES_NOT_FOUND' ? 404 :
    error.code === 'EVALUATION_IDEMPOTENCY_CONFLICT' ? 409 : 400;
  return new ApiProblem({
    status,
    code: error.code,
    title: 'Evaluation submission rejected',
    detail: error.message,
  });
}

export const POST = withApiSecurity(
  {
    permission: 'security:operate',
    bodySchema: submitEvaluationRunSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 1_024 * 1_024,
    auditEvent: 'evaluation.submit',
    rateLimitPolicy: { id: 'evaluation-submit', windowMs: 60_000, maxRequests: 20, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      const submission = await submitEvaluationRun({
        scope: requireTenantContext(principal),
        actorId: principal!.subject,
        ...body,
      });
      return Response.json({
        success: true,
        data: submission.run,
        reused: submission.reused,
      }, { status: submission.reused ? 200 : 202 });
    } catch (error) {
      if (error instanceof EvaluationSubmissionError) throw submissionProblem(error);
      throw error;
    }
  },
);

export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    querySchema: listEvaluationRunsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'evaluation.list',
    rateLimitPolicy: { id: 'evaluation-list', windowMs: 60_000, maxRequests: 60, scope: 'application' },
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const conditions = [scopePredicate(evaluationRuns, scope)];
    if (query.status) conditions.push(eq(evaluationRuns.status, query.status));
    const runs = await db.select().from(evaluationRuns)
      .where(and(...conditions))
      .orderBy(desc(evaluationRuns.createdAt))
      .limit(query.limit);
    return Response.json({ success: true, data: runs });
  },
);
