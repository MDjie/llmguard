import { z } from 'zod';
import { gatewayRequestDetailSchema, gatewayRequestListSchema, gatewayConsoleQuerySchema } from '@/contracts/http/gateway-console';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { readGatewayRequests } from '@/lib/gateway-runtime/console-service';
export const GET = withApiSecurity({ permission: 'history:read', querySchema: gatewayConsoleQuerySchema, responseSchema: z.union([gatewayRequestDetailSchema, gatewayRequestListSchema]),
  maxBodyBytes: 0, auditEvent: 'gateway.requests.read', rateLimitPolicy: { id: 'gateway-requests-read', windowMs: 60000, maxRequests: 120, scope: 'principal' },
}, async ({ principal, query }) => Response.json(await readGatewayRequests(requireTenantContext(principal), query)));
