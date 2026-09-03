import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { authorizeToolSchema } from '@/contracts/http/tools';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { authorizeToolInvocation, ToolPolicyError } from '@/lib/tools';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'guard:use', bodySchema: authorizeToolSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 2 * 1_024 * 1_024,
    auditEvent: 'tool.authorize',
    rateLimitPolicy: { id: 'tool-authorize', windowMs: 60_000, maxRequests: 240, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      const result = await authorizeToolInvocation({
        scope: requireTenantContext(principal), principalId: principal!.subject,
        roles: principal!.roles, permissions: principal!.permissions, ...body,
      });
      return Response.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof ToolPolicyError) {
        throw new ApiProblem({
          status: error.code === 'TOOL_IDEMPOTENCY_CONFLICT' ? 409 : 403,
          code: error.code, title: 'Tool invocation denied', detail: error.message,
        });
      }
      throw error;
    }
  },
);
