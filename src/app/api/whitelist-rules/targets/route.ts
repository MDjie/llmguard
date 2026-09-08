import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { whitelistTargets } from '@/lib/policy-governance/whitelist';
import { requireTenantContext } from '@/lib/tenancy';
export const GET = withApiSecurity({ permission: 'policy:read', querySchema: z.object({ policyId: z.string().min(1).max(36) }).strict(), responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0, auditEvent: 'whitelist.targets.read', rateLimitPolicy: { id: 'whitelist-targets', windowMs: 60_000, maxRequests: 60, scope: 'principal' } }, async ({ query, principal }) => Response.json({ success: true, data: await whitelistTargets(requireTenantContext(principal), [query.policyId]) }));
