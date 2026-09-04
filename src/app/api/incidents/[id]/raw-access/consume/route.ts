import { consumeContentAccessRequestSchema, contentAccessConsumeResponseSchema } from '@/contracts/http/content-access';
import { incidentParamsSchema } from '@/contracts/http/incidents';
import { withApiSecurity } from '@/lib/api-security';
import { consumeIncidentEvidenceAccess } from '@/lib/incidents/content-access';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'content:raw:read', paramsSchema: incidentParamsSchema,
    bodySchema: consumeContentAccessRequestSchema, responseSchema: contentAccessConsumeResponseSchema, maxBodyBytes: 512,
    auditEvent: 'incident.evidence-access.consume',
    rateLimitPolicy: { id: 'incident-evidence-access-consume', windowMs: 60_000, maxRequests: 20, scope: 'principal' },
  },
  async ({ routeContext, body, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    return Response.json({
      success: true,
      data: await consumeIncidentEvidenceAccess(requireTenantContext(principal), id, body.requestId),
    }, { headers: { 'cache-control': 'no-store, max-age=0', pragma: 'no-cache' } });
  },
);
