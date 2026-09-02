import { and, eq } from 'drizzle-orm';
import { guardDecisionSchema, guardRequestSchema } from '@/contracts/http/guard-v1';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applicationPolicyBindings } from '@/storage/database/shared/schema';

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: guardRequestSchema,
    responseSchema: guardDecisionSchema,
    maxBodyBytes: 2 * 1_024 * 1_024,
    auditEvent: 'guard.v1.evaluate-shadow',
    rateLimitPolicy: { id: 'guard-v1-shadow', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    if (body.context.tenantId !== scope.tenantId || body.context.applicationId !== scope.applicationId) {
      throw new ApiProblem({
        status: 403,
        code: 'GUARD_SCOPE_MISMATCH',
        title: 'Guard scope mismatch',
        detail: 'The request context must match the authenticated application.',
      });
    }
    const [binding] = await db.select({ id: applicationPolicyBindings.id })
      .from(applicationPolicyBindings).where(and(
        scopePredicate(applicationPolicyBindings, scope),
        eq(applicationPolicyBindings.shadowBundleId, body.context.policyBundleId),
      )).limit(1);
    if (!binding) {
      throw new ApiProblem({
        status: 409,
        code: 'GUARD_SHADOW_BUNDLE_NOT_BOUND',
        title: 'Shadow policy bundle is not bound',
        detail: 'Only the application shadow bundle can be evaluated on this endpoint.',
      });
    }
    if (body.context.absoluteDeadlineEpochMs <= Date.now() || body.content.text === undefined) {
      throw new ApiProblem({
        status: 422,
        code: 'GUARD_SHADOW_REQUEST_INVALID',
        title: 'Invalid shadow request',
        detail: 'A future deadline and text content are required.',
      });
    }
    try {
      const bundle = await loadVerifiedPolicyBundle(scope, body.context.policyBundleId);
      return Response.json(await createEngineForPolicyBundle(bundle).evaluate(body));
    } catch {
      throw new ApiProblem({
        status: 503,
        code: 'GUARD_SHADOW_POLICY_UNAVAILABLE',
        title: 'Shadow policy unavailable',
        detail: 'The signed shadow policy could not be loaded or verified.',
      });
    }
  },
);
