import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { ToolPolicyError } from '@/lib/tools/policy';
import { reconcileToolInvocation } from '@/lib/tools/reconciliation';

export const POST = withApiSecurity({
  permission: 'guard:use', bodySchema: z.object({ invocationId: z.string().uuid(), queryId: z.string().uuid() }).strict(), responseSchema: jsonObjectResponseSchema,
  maxBodyBytes: 4096, auditEvent: 'tool.execution.reconcile', rateLimitPolicy: { id: 'tool-reconcile', windowMs: 60000, maxRequests: 60, scope: 'application' },
}, async ({ body, principal, request }) => {
  try {
    const data = await reconcileToolInvocation({ ...body, scope: requireTenantContext(principal), principalId: principal!.subject, signal: request.signal });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof ToolPolicyError) throw new ApiProblem({ status: error.code === 'TOOL_RECONCILIATION_LIMIT' ? 429 : 403, code: error.code, title: 'Tool query rejected', detail: error.message });
    throw error;
  }
});
