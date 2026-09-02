import { and, asc, eq } from 'drizzle-orm';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { evaluationRunParamsSchema } from '@/contracts/http/evaluation-runs';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { evaluationResults, evaluationRuns } from '@/storage/database/shared/schema';

export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: evaluationRunParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'evaluation.read',
    rateLimitPolicy: { id: 'evaluation-read', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ principal, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const [run] = await db.select().from(evaluationRuns).where(and(
      eq(evaluationRuns.id, id),
      scopePredicate(evaluationRuns, scope),
    )).limit(1);
    if (!run) {
      throw new ApiProblem({
        status: 404,
        code: 'EVALUATION_RUN_NOT_FOUND',
        title: 'Evaluation run not found',
        detail: 'The evaluation run does not exist in the current application scope.',
      });
    }
    const results = await db.select().from(evaluationResults).where(and(
      eq(evaluationResults.runId, id),
      scopePredicate(evaluationResults, scope),
    )).orderBy(asc(evaluationResults.createdAt)).limit(10_000);
    return Response.json({ success: true, data: { ...run, results } });
  },
);
