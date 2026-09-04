import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { governanceIdParamsSchema, previewResponseTemplateSchema } from '@/contracts/http/policy-governance';
import { withApiSecurity } from '@/lib/api-security';
import { PolicyGovernanceOperationError, previewResponseTemplate } from '@/lib/policy-governance';
import { policyGovernanceProblem } from '@/lib/policy-governance/problem';
import { requireTenantContext } from '@/lib/tenancy';

const bodySchema = previewResponseTemplateSchema.omit({ templateId: true });

export const POST = withApiSecurity(
  {
    permission: 'policy:read', paramsSchema: governanceIdParamsSchema,
    bodySchema, responseSchema: jsonObjectResponseSchema, maxBodyBytes: 16_384,
    auditEvent: 'policy.template.preview',
    rateLimitPolicy: { id: 'policy-template-preview', windowMs: 60_000, maxRequests: 60, scope: 'application' },
  },
  async ({ routeContext, body, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    try {
      return Response.json({ success: true, data: await previewResponseTemplate(requireTenantContext(principal), { templateId: id, variables: body.variables }) });
    } catch (error) {
      if (error instanceof PolicyGovernanceOperationError) throw policyGovernanceProblem(error);
      throw error;
    }
  },
);
