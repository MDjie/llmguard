import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { gatewayContentHoldSchema, readGatewayContentRetention, setGatewayContentHold } from '@/lib/gateway-runtime/content-retention';
export const GET = withApiSecurity({ permission: 'audit:read', querySchema: z.object({ requestId: z.string().regex(/^[-_a-zA-Z0-9]{1,128}$/u) }).strict(),
  maxBodyBytes: 0, auditEvent: 'gateway.content-retention.read', rateLimitPolicy: { id: 'gateway-retention-read', windowMs: 60000, maxRequests: 60, scope: 'principal' } }, async ({ principal, query }) =>
  Response.json(await readGatewayContentRetention(requireTenantContext(principal), query.requestId), { headers: { 'cache-control': 'no-store' } }));
export const POST = withApiSecurity({ permission: 'security:operate', bodySchema: gatewayContentHoldSchema, maxBodyBytes: 8192, auditEvent: 'gateway.content-retention.change', rateLimitPolicy: { id: 'gateway-retention-change', windowMs: 60000, maxRequests: 20, scope: 'principal' } },
  async ({ principal, body }) => { const scope = requireTenantContext(principal); return Response.json(await setGatewayContentHold(scope, scope.principalId, body), { headers: { 'cache-control': 'no-store' } }); });
