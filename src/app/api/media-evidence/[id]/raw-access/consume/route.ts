import { mediaEvidenceProblem } from '@/lib/evidence/problem';
import { z } from 'zod';
import { contentAccessConsumeResponseSchema, consumeContentAccessRequestSchema } from '@/contracts/http/content-access';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { consumeMediaEvidence } from '@/lib/evidence/media-snapshots';
export const POST = withApiSecurity({ permission: 'content:raw:read', paramsSchema: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  responseSchema: contentAccessConsumeResponseSchema, bodySchema: consumeContentAccessRequestSchema, maxBodyBytes: 2048, auditEvent: 'media.evidence.content-access.consume',
  rateLimitPolicy: { id: 'media-evidence-access-consume', windowMs: 60000, maxRequests: 30, scope: 'principal' },
}, async ({ principal, routeContext, body }) => {
  const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
  return Response.json({ success: true, data: await consumeMediaEvidence(requireTenantContext(principal), id, body.requestId).catch(mediaEvidenceProblem) }, { headers: { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache' } });
});
