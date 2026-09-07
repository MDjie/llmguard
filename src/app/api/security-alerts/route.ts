import { alertQuerySchema, alertListSchema } from '@/contracts/http/security-alerts';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { listSecurityAlerts } from '@/lib/security-alerts/service';
export const GET = withApiSecurity({ permission: 'security:operate', querySchema: alertQuerySchema, responseSchema: alertListSchema,
  maxBodyBytes: 0, auditEvent: 'security.alerts.list', rateLimitPolicy: { id: 'security-alerts-list', windowMs: 60000, maxRequests: 120, scope: 'principal' },
}, async ({ principal, query }) => Response.json(await listSecurityAlerts(requireTenantContext(principal), query)));
