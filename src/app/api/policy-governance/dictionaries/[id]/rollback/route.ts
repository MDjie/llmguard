import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { dictionaryReasonSchema, governanceIdParamsSchema } from '@/contracts/http/policy-governance';
import { withApiSecurity } from '@/lib/api-security';
import { PolicyGovernanceOperationError, rollbackDictionaryRelease } from '@/lib/policy-governance';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'policy:publish', paramsSchema: governanceIdParamsSchema,
    bodySchema: dictionaryReasonSchema, responseSchema: jsonObjectResponseSchema, maxBodyBytes: 2_048,
    auditEvent: 'policy.dictionary.rollback',
    rateLimitPolicy: { id: 'policy-dictionary-rollback', windowMs: 60_000, maxRequests: 10, scope: 'application' },
  },
  async ({ routeContext, body, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    try {
      return Response.json({ success: true, data: await rollbackDictionaryRelease(requireTenantContext(principal), principal!.subject, id, body.reason) });
    } catch (error) {
      if (error instanceof PolicyGovernanceOperationError) throw policyGovernanceProblem(error);
      throw error;
    }
  },
);
