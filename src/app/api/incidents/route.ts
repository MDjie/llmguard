import { createIncidentSchema, incidentListQuerySchema, incidentResponseSchema } from '@/contracts/http/incidents';
import { withApiSecurity } from '@/lib/api-security';
import { createIncident, listIncidents } from '@/lib/incidents';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    querySchema: incidentListQuerySchema,
    responseSchema: incidentResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'incident.list',
    rateLimitPolicy: { id: 'incident-list', windowMs: 60_000, maxRequests: 120, scope: 'principal' },
  },
  async ({ query, principal }) => Response.json(await listIncidents(requireTenantContext(principal), {
    status: query.status,
    severity: query.severity,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  })),
);

export const POST = withApiSecurity(
  {
    permission: 'security:operate',
    bodySchema: createIncidentSchema,
    responseSchema: incidentResponseSchema,
    maxBodyBytes: 24_000,
    auditEvent: 'incident.create',
    rateLimitPolicy: { id: 'incident-create', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
  },
  async ({ body, principal }) => Response.json(await createIncident(requireTenantContext(principal), body), { status: 201 }),
);
