import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { releaseHealthSchema } from '@/contracts/http/policy-governance';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { PolicyBundleTransitionError, reconcilePolicyReleaseHealth } from '@/lib/policy-bundle';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'policy:publish', bodySchema: releaseHealthSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 16_384,
    auditEvent: 'policy.bundle.health-reconcile',
    rateLimitPolicy: { id: 'policy-bundle-health', windowMs: 60_000, maxRequests: 60, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      return Response.json({
        success: true,
        data: await reconcilePolicyReleaseHealth(requireTenantContext(principal), principal!.subject, body),
      });
    } catch (error) {
      if (error instanceof PolicyBundleTransitionError) {
        throw new ApiProblem({ status: 409, code: error.code, title: 'Policy release health action rejected', detail: error.message });
      }
      throw error;
    }
  },
);
