import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { toolResultSchema } from '@/contracts/http/tools';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { guardToolResult, ToolPolicyError } from '@/lib/tools';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'guard:use', bodySchema: toolResultSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 2 * 1_024 * 1_024,
    auditEvent: 'tool.result.guard',
    rateLimitPolicy: { id: 'tool-result-guard', windowMs: 60_000, maxRequests: 240, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      const result = await guardToolResult({ scope: requireTenantContext(principal), ...body });
      return Response.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof ToolPolicyError) {
        throw new ApiProblem({ status: 403, code: error.code, title: 'Tool result rejected', detail: error.message });
      }
      throw error;
    }
  },
);
