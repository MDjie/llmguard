import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { guardDecisionSchema, guardRequestSchema } from '@/contracts/http/guard-v1';
import {
  createEngineForPolicyBundle,
  evaluateWithSessionContext,
} from '@/lib/guard-engine-v2';
import { loadRuntimePolicyBundle } from '@/lib/policy-bundle';
import { requireTenantContext } from '@/lib/tenancy';
import {
  admitGuardRequest,
  GuardResourceAdmissionError,
  type GuardResourceAdmission,
} from '@/lib/resource-control';

const MAX_DEADLINE_MS = 60_000;

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: guardRequestSchema,
    responseSchema: guardDecisionSchema,
    maxBodyBytes: 2 * 1_024 * 1_024,
    auditEvent: 'guard.v1.evaluate',
    rateLimitPolicy: {
      id: 'guard-v1-evaluate',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'application',
    },
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    if (
      body.context.tenantId !== scope.tenantId ||
      body.context.applicationId !== scope.applicationId
    ) {
      throw new ApiProblem({
        status: 403,
        code: 'GUARD_SCOPE_MISMATCH',
        title: 'Guard scope mismatch',
        detail: 'The request context must match the authenticated tenant and application.',
      });
    }
    const now = Date.now();
    if (
      body.context.absoluteDeadlineEpochMs <= now ||
      body.context.absoluteDeadlineEpochMs - now > MAX_DEADLINE_MS
    ) {
      throw new ApiProblem({
        status: 400,
        code: 'GUARD_DEADLINE_INVALID',
        title: 'Invalid guard deadline',
        detail: 'The absolute deadline must be in the future and no more than 60 seconds away.',
      });
    }
    if (body.content.text === undefined) {
      throw new ApiProblem({
        status: 422,
        code: 'GUARD_ARTIFACT_PIPELINE_REQUIRED',
        title: 'Artifact pipeline required',
        detail: 'Artifact-only requests must use the asynchronous artifact pipeline.',
      });
    }
    let bundle;
    try {
      bundle = await loadRuntimePolicyBundle(
        scope,
        body.context.policyBundleId,
        body.context.requestId,
      );
    } catch {
      throw new ApiProblem({
        status: 503,
        code: 'GUARD_POLICY_UNAVAILABLE',
        title: 'Guard policy unavailable',
        detail: 'The requested policy bundle is not active in this application.',
      });
    }
    const engine = createEngineForPolicyBundle(bundle);
    let admission: GuardResourceAdmission | undefined;
    try {
      if (bundle.payload.resourceAdmission) {
        admission = await admitGuardRequest({
          spec: bundle.payload.resourceAdmission,
          bundleId: bundle.id,
          scope,
          principal: principal!,
          request: body,
        });
      }
      return Response.json(await evaluateWithSessionContext(engine, body, scope));
    } catch (error) {
      if (error instanceof GuardResourceAdmissionError) {
        const status = error.code === 'GUARD_QUOTA_EXCEEDED'
          ? 429
          : error.code === 'GUARD_REQUEST_ID_REPLAYED'
            ? 409
          : error.code === 'GUARD_INPUT_TOKEN_LIMIT_EXCEEDED'
            ? 413
            : 503;
        throw new ApiProblem({
          status,
          code: error.code,
          title: 'Guard resource admission rejected',
          detail: error.message,
        });
      }
      throw error;
    } finally {
      await admission?.release();
    }
  },
);
