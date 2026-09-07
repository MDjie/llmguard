import { z } from 'zod';
import { contentAccessOwnListResponseSchema } from '@/contracts/http/content-access';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { listRequesterEvidenceAccess } from '@/lib/incidents/content-access';
export const GET = withApiSecurity({ permission: 'content:raw:read', paramsSchema: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  responseSchema: contentAccessOwnListResponseSchema, maxBodyBytes: 0, auditEvent: 'archive.content-access.requests',
  rateLimitPolicy: { id: 'archive-access-requests', windowMs: 60000, maxRequests: 30, scope: 'principal' },
}, async ({ principal, routeContext }) => {
  const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
  return Response.json({ success: true, data: await listRequesterEvidenceAccess(requireTenantContext(principal), id, 'ARCHIVED_CONTENT') }, { headers: { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache' } });
});
