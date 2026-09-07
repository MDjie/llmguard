import { z } from 'zod';
import { archiveQuerySchema, archiveMessagesSchema } from '@/contracts/http/conversation-archive';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { listArchivedMessages } from '@/lib/conversation-archive/query';
export const GET = withApiSecurity({ permission: 'history:read', querySchema: archiveQuerySchema, responseSchema: archiveMessagesSchema,
  paramsSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
  maxBodyBytes: 0, auditEvent: 'archive.messages.read', rateLimitPolicy: { id: 'archive-messages', windowMs: 60000, maxRequests: 120, scope: 'principal' },
}, async ({ principal, query, routeContext }) => {
  const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
  return Response.json(await listArchivedMessages(requireTenantContext(principal), id, query));
});
