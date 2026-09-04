import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { shadowComparisonSchema } from '@/contracts/http/policy-governance';
import { withApiSecurity } from '@/lib/api-security';
import { evaluateShadowComparison, PolicyGovernanceOperationError } from '@/lib/policy-governance';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'policy:read', bodySchema: shadowComparisonSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 262_144,
    auditEvent: 'policy.shadow.compare',
    rateLimitPolicy: { id: 'policy-shadow-compare', windowMs: 60_000, maxRequests: 30, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      return Response.json({ success: true, data: await evaluateShadowComparison(requireTenantContext(principal), body.request) });
    } catch (error) {
      if (error instanceof PolicyGovernanceOperationError) throw policyGovernanceProblem(error);
      throw error;
    }
  },
);
