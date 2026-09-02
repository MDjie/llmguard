import { auditApiResponseSchema, auditReportQuerySchema } from '@/contracts/http/audit';
import { withApiSecurity } from '@/lib/api-security';
import { generateAuditReport } from '@/lib/audit';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity({
  permission: 'audit:read', querySchema: auditReportQuerySchema, responseSchema: auditApiResponseSchema,
  maxBodyBytes: 0, auditEvent: 'audit.report.generate',
  rateLimitPolicy: { id: 'audit-report-generate', windowMs: 60_000, maxRequests: 30, scope: 'principal' },
}, async ({ query, principal }) => Response.json(
  await generateAuditReport(requireTenantContext(principal), query.period, query.anchor),
));
