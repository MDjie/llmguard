import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { governanceIdParamsSchema, publishDictionarySchema } from '@/contracts/http/policy-governance';
import { withApiSecurity } from '@/lib/api-security';
import { PolicyGovernanceOperationError, publishDictionaryRelease } from '@/lib/policy-governance';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'policy:publish', paramsSchema: governanceIdParamsSchema,
    bodySchema: publishDictionarySchema, responseSchema: jsonObjectResponseSchema, maxBodyBytes: 2_048,
    auditEvent: 'policy.dictionary.publish',
    rateLimitPolicy: { id: 'policy-dictionary-publish', windowMs: 60_000, maxRequests: 20, scope: 'application' },
  },
  async ({ routeContext, body, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    try {
      return Response.json({ success: true, data: await publishDictionaryRelease(requireTenantContext(principal), principal!.subject, id, body.mode, body.reason) });
    } catch (error) {
      if (error instanceof PolicyGovernanceOperationError) throw policyGovernanceProblem(error);
      throw error;
    }
  },
);
