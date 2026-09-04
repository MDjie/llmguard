import { contentAccessRequestResponseSchema, createContentAccessRequestSchema } from '@/contracts/http/content-access';
import { incidentParamsSchema } from '@/contracts/http/incidents';
import { withApiSecurity } from '@/lib/api-security';
import { requestIncidentEvidenceAccess } from '@/lib/incidents/content-access';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'content:raw:read', paramsSchema: incidentParamsSchema,
    bodySchema: createContentAccessRequestSchema, responseSchema: contentAccessRequestResponseSchema, maxBodyBytes: 2_048,
    auditEvent: 'incident.evidence-access.request',
    rateLimitPolicy: { id: 'incident-evidence-access-request', windowMs: 60_000, maxRequests: 20, scope: 'principal' },
  },
  async ({ routeContext, body, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    return Response.json({
      success: true,
      data: await requestIncidentEvidenceAccess(requireTenantContext(principal), id, body),
    }, { status: 201 });
  },
);
