import { archiveQuerySchema, archiveListSchema } from '@/contracts/http/conversation-archive';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { listConversationArchives } from '@/lib/conversation-archive/query';
export const GET = withApiSecurity({ permission: 'history:read', querySchema: archiveQuerySchema, responseSchema: archiveListSchema,
  maxBodyBytes: 0, auditEvent: 'archive.list.read', rateLimitPolicy: { id: 'archive-list', windowMs: 60000, maxRequests: 120, scope: 'principal' },
}, async ({ principal, query }) => {
  return Response.json(await listConversationArchives(requireTenantContext(principal), query));
});
