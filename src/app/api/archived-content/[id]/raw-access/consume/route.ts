import { z } from 'zod';
import { contentAccessConsumeResponseSchema, consumeContentAccessRequestSchema } from '@/contracts/http/content-access';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { consumeArchivedContentAccess } from '@/lib/conversation-archive/access';
export const POST = withApiSecurity({ permission: 'content:raw:read', paramsSchema: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  responseSchema: contentAccessConsumeResponseSchema, bodySchema: consumeContentAccessRequestSchema, maxBodyBytes: 2048, auditEvent: 'archive.content-access.consume',
  rateLimitPolicy: { id: 'archive-access-consume', windowMs: 60000, maxRequests: 30, scope: 'principal' },
}, async ({ principal, routeContext, body }) => {
  const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
  return Response.json({ success: true, data: await consumeArchivedContentAccess(requireTenantContext(principal), id, body.requestId) }, { headers: { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache' } });
});
