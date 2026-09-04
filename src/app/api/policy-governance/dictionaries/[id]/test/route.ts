import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { governanceIdParamsSchema } from '@/contracts/http/policy-governance';
import { withApiSecurity } from '@/lib/api-security';
import { PolicyGovernanceOperationError, testDictionaryRelease } from '@/lib/policy-governance';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'policy:write', paramsSchema: governanceIdParamsSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0,
    auditEvent: 'policy.dictionary.test',
    rateLimitPolicy: { id: 'policy-dictionary-test', windowMs: 60_000, maxRequests: 30, scope: 'application' },
  },
  async ({ routeContext, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    try {
      return Response.json({ success: true, data: await testDictionaryRelease(requireTenantContext(principal), principal!.subject, id) });
    } catch (error) {
      if (error instanceof PolicyGovernanceOperationError) throw policyGovernanceProblem(error);
      throw error;
    }
  },
);
