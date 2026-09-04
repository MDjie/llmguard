import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  createResponseTemplateSchema,
  listResponseTemplatesSchema,
} from '@/contracts/http/policy-governance';
import { withApiSecurity } from '@/lib/api-security';
import {
  createResponseTemplateDraft,
  listResponseTemplates,
  PolicyGovernanceOperationError,
} from '@/lib/policy-governance';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity(
  {
    permission: 'policy:read', querySchema: listResponseTemplatesSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0,
    auditEvent: 'policy.template.list',
    rateLimitPolicy: { id: 'policy-template-list', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ query, principal }) => Response.json({
    success: true,
    data: await listResponseTemplates(requireTenantContext(principal), query),
  }),
);

export const POST = withApiSecurity(
  {
    permission: 'policy:write', bodySchema: createResponseTemplateSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 16_384,
    auditEvent: 'policy.template.create',
    rateLimitPolicy: { id: 'policy-template-create', windowMs: 60_000, maxRequests: 20, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      return Response.json({
        success: true,
        data: await createResponseTemplateDraft(requireTenantContext(principal), principal!.subject, body),
      }, { status: 201 });
    } catch (error) {
      if (error instanceof PolicyGovernanceOperationError) throw policyGovernanceProblem(error);
      throw error;
    }
  },
);
