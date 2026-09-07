import { z } from 'zod';
import { alertViewSchema } from '@/contracts/http/security-alerts';
import { withApiSecurity, ApiProblem } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { readSecurityAlert } from '@/lib/security-alerts/service';
export const GET = withApiSecurity({ permission: 'security:operate', paramsSchema: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), responseSchema: alertViewSchema,
  maxBodyBytes: 0, auditEvent: 'security.alerts.detail', rateLimitPolicy: { id: 'security-alerts-detail', windowMs: 60000, maxRequests: 120, scope: 'principal' },
}, async ({ principal, routeContext }) => {
  const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
  const result = await readSecurityAlert(requireTenantContext(principal), id);
  if (!result) throw new ApiProblem({ status: 404, code: 'ALERT_NOT_FOUND', title: 'Alert not found', detail: 'The alert does not exist in this application.' });
  return Response.json(result);
});
