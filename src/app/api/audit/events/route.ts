import { auditApiResponseSchema, auditEventsQuerySchema } from '@/contracts/http/audit';
import { withApiSecurity } from '@/lib/api-security';
import { listAuditEvents } from '@/lib/audit';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity({
  permission: 'audit:read', querySchema: auditEventsQuerySchema, responseSchema: auditApiResponseSchema,
  maxBodyBytes: 0, auditEvent: 'audit.events.search',
  rateLimitPolicy: { id: 'audit-events-search', windowMs: 60_000, maxRequests: 120, scope: 'principal' },
}, async ({ query, principal }) => Response.json(await listAuditEvents(requireTenantContext(principal), {
  eventPrefix: query.eventPrefix, outcome: query.outcome, status: query.status,
  principalId: query.principalId, traceId: query.traceId, requestId: query.requestId,
  pathPrefix: query.pathPrefix, from: query.from, to: query.to,
  limit: query.pageSize, offset: (query.page - 1) * query.pageSize,
})));
