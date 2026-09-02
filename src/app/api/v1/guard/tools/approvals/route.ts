import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { toolApprovalSchema } from '@/contracts/http/tools';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { decideToolApproval, ToolPolicyError } from '@/lib/tools';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'security:operate', bodySchema: toolApprovalSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 16 * 1_024,
    auditEvent: 'tool.approval.decide',
    rateLimitPolicy: { id: 'tool-approval', windowMs: 60_000, maxRequests: 60, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      const result = await decideToolApproval(
        requireTenantContext(principal), principal!.subject,
        body.invocationId, body.decision, body.reason,
      );
      return Response.json({ success: true, data: result });
    } catch (error) {
      if (error instanceof ToolPolicyError) {
        throw new ApiProblem({ status: 409, code: error.code, title: 'Tool approval rejected', detail: error.message });
      }
      throw error;
    }
  },
);
