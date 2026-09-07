import { z } from 'zod';
import { contentAccessRequestResponseSchema, createContentAccessRequestSchema } from '@/contracts/http/content-access';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { requestEvidenceAccess } from '@/lib/incidents/content-access';
export const POST = withApiSecurity({ permission: 'content:raw:read', paramsSchema: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  responseSchema: contentAccessRequestResponseSchema, bodySchema: createContentAccessRequestSchema, maxBodyBytes: 2048, auditEvent: 'media.evidence.content-access.request',
  rateLimitPolicy: { id: 'media-evidence-access-request', windowMs: 60000, maxRequests: 30, scope: 'principal' },
}, async ({ principal, routeContext, body }) => {
  const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
  return Response.json({ success: true, data: await requestEvidenceAccess(requireTenantContext(principal), id, body, 'MEDIA_EVIDENCE') }, { headers: { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache' } });
});
