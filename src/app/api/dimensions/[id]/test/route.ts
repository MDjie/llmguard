import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { jsonObjectResponseSchema, idOrCodeParamsSchema } from '@/contracts/http/common';
import { testDimensionSchema } from '@/contracts/http/dimensions';
import { testDimension } from '@/lib/dimensions/service';

export const runtime = 'nodejs';

export const POST = withApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: idOrCodeParamsSchema,
    bodySchema: testDimensionSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1024,
    auditEvent: 'dimension.testDimension',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--test-route-ts-post', windowMs: 60000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal, body, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const data = await testDimension(scope,id,body.text);
    return Response.json({ success: true, data });
  },
);
