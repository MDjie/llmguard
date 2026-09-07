import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { executeToolSchema } from '@/contracts/http/tools';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { executeToolInvocation } from '@/lib/tools/execution';
import { ToolPolicyError } from '@/lib/tools/policy';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity({
  permission: 'guard:use', bodySchema: executeToolSchema, responseSchema: jsonObjectResponseSchema,
  maxBodyBytes: 2 * 1024 * 1024, auditEvent: 'tool.execute',
  rateLimitPolicy: { id: 'tool-execute', windowMs: 60000, maxRequests: 240, scope: 'application' },
}, async ({ body, principal, request }) => {
  try {
    const result = await executeToolInvocation({
      ...body, scope: requireTenantContext(principal), principalId: principal!.subject, signal: request.signal,
    });
    return Response.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ToolPolicyError) throw new ApiProblem({
      status: error.code === 'TOOL_PERMIT_ALREADY_CONSUMED' ? 409 : error.code === 'TOOL_EXECUTION_UNKNOWN' ? 503 : 403,
      code: error.code, title: 'Tool execution rejected', detail: error.message,
    });
    throw error;
  }
});
