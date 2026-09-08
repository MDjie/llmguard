import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { createDimensionSchema } from '@/contracts/http/dimensions';
import { listDimensions, createDimension } from '@/lib/dimensions/service';

export const runtime = 'nodejs';

export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.listDimensions',
    rateLimitPolicy: { id: 'src-app-api-dimensions-route-ts-get', windowMs: 60000, maxRequests: 120, scope: 'principal' },
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const data = await listDimensions(scope);
    return Response.json({ success: true, data });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'policy:manage',
    bodySchema: createDimensionSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1024,
    auditEvent: 'dimension.createDimension',
    rateLimitPolicy: { id: 'src-app-api-dimensions-route-ts-post', windowMs: 60000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal, body }) => {
    const scope = requireTenantContext(principal);
    const data = await createDimension(scope,body);
    return Response.json({ success: true, data });
  },
);
