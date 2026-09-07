import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { verifyGatewayAuditBatch } from '@/lib/gateway-runtime/audit-batches';
export const GET = withApiSecurity({ permission: 'audit:read', querySchema: z.object({ id: z.string().uuid() }).strict(), maxBodyBytes: 0,
  auditEvent: 'gateway.audit-batch.read', rateLimitPolicy: { id: 'gateway-audit-batch-read', windowMs: 60000, maxRequests: 30, scope: 'principal' } },
  async ({ query, principal }) => {
    const batch = await verifyGatewayAuditBatch(requireTenantContext(principal), query.id);
    if (!batch) throw new ApiProblem({ code: 'GATEWAY_AUDIT_BATCH_MISSING', title: 'Audit batch unavailable', detail: 'No audit batch exists in the authenticated scope.', status: 404 });
    return Response.json(batch, { headers: { 'cache-control': 'no-store' } });
  });
