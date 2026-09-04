import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  createDictionaryDraftSchema,
  listDictionaryReleasesSchema,
} from '@/contracts/http/policy-governance';
import { withApiSecurity } from '@/lib/api-security';
import {
  createDictionaryDraft,
  listDictionaryReleases,
  PolicyGovernanceOperationError,
} from '@/lib/policy-governance';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    querySchema: listDictionaryReleasesSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'policy.dictionary.list',
    rateLimitPolicy: { id: 'policy-dictionary-list', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ query, principal }) => Response.json({
    success: true,
    data: await listDictionaryReleases(requireTenantContext(principal), query),
  }),
);

export const POST = withApiSecurity(
  {
    permission: 'policy:write',
    bodySchema: createDictionaryDraftSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 1_048_576,
    auditEvent: 'policy.dictionary.create',
    rateLimitPolicy: { id: 'policy-dictionary-create', windowMs: 60_000, maxRequests: 10, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      return Response.json({
        success: true,
        data: await createDictionaryDraft(requireTenantContext(principal), principal!.subject, body),
      }, { status: 201 });
    } catch (error) {
      if (error instanceof PolicyGovernanceOperationError) throw policyGovernanceProblem(error);
      throw error;
    }
  },
);
