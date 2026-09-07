import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { createAlertIncident } from '@/lib/security-alerts/service';
export const POST = withApiSecurity({ permission: 'security:operate', paramsSchema: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  responseSchema: z.object({ incidentId: z.uuid(), created: z.boolean() }).strict(), maxBodyBytes: 0, auditEvent: 'security.alerts.incident',
  rateLimitPolicy: { id: 'security-alert-incident', windowMs: 60000, maxRequests: 30, scope: 'principal' },
}, async ({ principal, routeContext }) => {
  const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
  return Response.json(await createAlertIncident(requireTenantContext(principal), id));
});
