import { contentAccessRequestParamsSchema, contentAccessRequestResponseSchema, reviewContentAccessRequestSchema } from '@/contracts/http/content-access';
import { withApiSecurity } from '@/lib/api-security';
import { reviewContentAccessRequest } from '@/lib/incidents/content-access';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'audit:approve', paramsSchema: contentAccessRequestParamsSchema,
    bodySchema: reviewContentAccessRequestSchema, responseSchema: contentAccessRequestResponseSchema, maxBodyBytes: 2_048,
    auditEvent: 'incident.evidence-access.review',
    rateLimitPolicy: { id: 'incident-evidence-access-review', windowMs: 60_000, maxRequests: 30, scope: 'principal' },
  },
  async ({ routeContext, body, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    return Response.json({
      success: true,
      data: await reviewContentAccessRequest(requireTenantContext(principal), id, body),
    });
  },
);
