import { and, asc, eq } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { runTestCasesSchema } from '@/contracts/http/test-cases';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  EvaluationSubmissionError,
  submitEvaluationRun,
} from '@/lib/evaluation';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  applicationPolicyBindings,
  policyBundles,
  testCases,
} from '@/storage/database/shared/schema';

export const POST = withApiSecurity(
  {
    permission: 'security:operate',
    bodySchema: runTestCasesSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'evaluation.legacy-submit',
    rateLimitPolicy: { id: 'evaluation-legacy-submit', windowMs: 60_000, maxRequests: 5, scope: 'application' },
  },
  async ({ body, principal, request, requestContext }) => {
    const scope = requireTenantContext(principal);
    const [binding] = await db.select().from(applicationPolicyBindings)
      .where(scopePredicate(applicationPolicyBindings, scope)).limit(1);
    if (!binding?.activeBundleId) {
      throw new ApiProblem({
        status: 409,
        code: 'EVALUATION_ACTIVE_BUNDLE_REQUIRED',
        title: 'Active policy bundle required',
        detail: 'Activate a signed policy bundle before submitting an evaluation.',
      });
    }
    if (body.policyId) {
      const [activeBundle] = await db.select({ policyId: policyBundles.policyId })
        .from(policyBundles).where(and(
          eq(policyBundles.id, binding.activeBundleId),
          scopePredicate(policyBundles, scope),
        )).limit(1);
      if (activeBundle?.policyId !== body.policyId) {
        throw new ApiProblem({
          status: 409,
          code: 'EVALUATION_POLICY_NOT_ACTIVE',
          title: 'Requested policy is not active',
          detail: 'The legacy policyId must match the application active bundle.',
        });
      }
    }
    let testCaseIds = body.testCaseIds;
    if (!testCaseIds?.length) {
      const rows = await db.select({ id: testCases.id }).from(testCases).where(and(
        scopePredicate(testCases, scope),
        eq(testCases.enabled, true),
      )).orderBy(asc(testCases.id)).limit(10_000);
      testCaseIds = rows.map((item) => item.id);
    }
    try {
      const result = await submitEvaluationRun({
        scope,
        actorId: principal!.subject,
        bundleId: binding.activeBundleId,
        testCaseIds,
        idempotencyKey:
          request.headers.get('idempotency-key') ?? `legacy-${requestContext.requestId}`,
      });
      return Response.json({
        success: true,
        data: result.run,
        reused: result.reused,
        compatibilityNotice: 'Execution is asynchronous; query /api/evaluation-runs/{id}.',
      }, { status: result.reused ? 200 : 202 });
    } catch (error) {
      if (error instanceof EvaluationSubmissionError) {
        throw new ApiProblem({
          status: error.code === 'EVALUATION_IDEMPOTENCY_CONFLICT' ? 409 : 400,
          code: error.code,
          title: 'Evaluation submission rejected',
          detail: error.message,
        });
      }
      throw error;
    }
  },
);
