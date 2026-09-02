import { incidentParamsSchema, incidentResponseSchema, transitionIncidentSchema } from '@/contracts/http/incidents';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { getIncident, transitionIncident } from '@/lib/incidents';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: incidentParamsSchema,
    responseSchema: incidentResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'incident.read',
    rateLimitPolicy: { id: 'incident-read', windowMs: 60_000, maxRequests: 120, scope: 'principal' },
  },
  async ({ routeContext, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const incident = await getIncident(requireTenantContext(principal), id);
    if (!incident) throw new ApiProblem({
      status: 404,
      code: 'INCIDENT_NOT_FOUND',
      title: 'Incident not found',
      detail: 'The incident does not exist in the current application scope.',
    });
    return Response.json(incident);
  },
);

export const PATCH = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: incidentParamsSchema,
    bodySchema: transitionIncidentSchema,
    responseSchema: incidentResponseSchema,
    maxBodyBytes: 8_192,
    auditEvent: 'incident.transition',
    rateLimitPolicy: { id: 'incident-transition', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
  },
  async ({ routeContext, body, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    return Response.json(await transitionIncident(requireTenantContext(principal), { incidentId: id, ...body }));
  },
);
