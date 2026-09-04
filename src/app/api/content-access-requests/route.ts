import { contentAccessReviewListResponseSchema, listContentAccessRequestsSchema } from '@/contracts/http/content-access';
import { withApiSecurity } from '@/lib/api-security';
import { listContentAccessRequests } from '@/lib/incidents/content-access';
import { requireTenantContext } from '@/lib/tenancy';

export const GET = withApiSecurity(
  {
    permission: 'audit:approve', querySchema: listContentAccessRequestsSchema,
    responseSchema: contentAccessReviewListResponseSchema, maxBodyBytes: 0,
    auditEvent: 'incident.evidence-access.list',
    rateLimitPolicy: { id: 'incident-evidence-access-list', windowMs: 60_000, maxRequests: 120, scope: 'principal' },
  },
  async ({ query, principal }) => Response.json({
    success: true,
    data: await listContentAccessRequests(requireTenantContext(principal), {
      status: query.status,
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    }),
  }),
);
