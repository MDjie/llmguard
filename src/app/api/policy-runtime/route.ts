import { policyRuntimeResponseSchema } from '@/contracts/http/policy-runtime';
import { withApiSecurity } from '@/lib/api-security';
import { getPolicyRuntimeSummary, PolicyGovernanceOperationError } from '@/lib/policy-governance';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity(
  {
    permission: 'policy:read', responseSchema: policyRuntimeResponseSchema, maxBodyBytes: 0,
    auditEvent: 'policy.runtime.read',
    rateLimitPolicy: { id: 'policy-runtime-read', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ principal }) => {
    try {
      return Response.json({ success: true, data: await getPolicyRuntimeSummary(requireTenantContext(principal)) });
    } catch (error) {
      if (error instanceof PolicyGovernanceOperationError) throw policyGovernanceProblem(error);
      throw error;
    }
  },
);
