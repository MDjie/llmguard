import { contentAccessOwnListResponseSchema } from '@/contracts/http/content-access';
import { incidentParamsSchema } from '@/contracts/http/incidents';
import { withApiSecurity } from '@/lib/api-security';
import { listRequesterIncidentEvidenceAccess } from '@/lib/incidents/content-access';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity(
  {
    permission: 'content:raw:read', paramsSchema: incidentParamsSchema,
    responseSchema: contentAccessOwnListResponseSchema, maxBodyBytes: 0,
    auditEvent: 'incident.evidence-access.own-list',
    rateLimitPolicy: { id: 'incident-evidence-access-own-list', windowMs: 60_000, maxRequests: 120, scope: 'principal' },
  },
  async ({ routeContext, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    return Response.json({
      success: true,
      data: await listRequesterIncidentEvidenceAccess(requireTenantContext(principal), id),
    });
  },
);
