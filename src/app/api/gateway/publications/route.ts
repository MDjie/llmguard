import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { listGatewayPublications, refreshGatewayPublication } from '@/lib/gateway-runtime/publication';
export const GET = withApiSecurity({ permission: 'policy:read', querySchema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict(),
  maxBodyBytes: 0, auditEvent: 'gateway.publications.read', rateLimitPolicy: { id: 'gateway-publications-read', windowMs: 60000, maxRequests: 60, scope: 'principal' } },
  async ({ query, principal }) => Response.json({ items: await listGatewayPublications(requireTenantContext(principal), query.limit) }, { headers: { 'cache-control': 'no-store' } }));
export const POST = withApiSecurity({ permission: 'security:operate', bodySchema: z.object({ expectedGeneration: z.number().int().nonnegative() }).strict(), maxBodyBytes: 1024,
  auditEvent: 'gateway.publications.refresh', rateLimitPolicy: { id: 'gateway-publications-refresh', windowMs: 60000, maxRequests: 10, scope: 'principal' } },
  async ({ body, principal }) => { const scope = requireTenantContext(principal); return Response.json(await refreshGatewayPublication(scope, scope.principalId, body.expectedGeneration)); });
