import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { jsonObjectResponseSchema, idOrCodeParamsSchema } from '@/contracts/http/common';
import { updateDimensionSchema } from '@/contracts/http/dimensions';
import { dimensionDetail, updateDimension, deleteDimension } from '@/lib/dimensions/service';

export const runtime = 'nodejs';

export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: idOrCodeParamsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.dimensionDetail',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--route-ts-get', windowMs: 60000, maxRequests: 120, scope: 'principal' },
  },
  async ({ principal, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const data = await dimensionDetail(scope,id);
    return Response.json({ success: true, data });
  },
);

export const PUT = withApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: idOrCodeParamsSchema,
    bodySchema: updateDimensionSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1024,
    auditEvent: 'dimension.updateDimension',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--route-ts-put', windowMs: 60000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal, body, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const data = await updateDimension(scope,id,body);
    return Response.json({ success: true, data });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: idOrCodeParamsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.deleteDimension',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--route-ts-delete', windowMs: 60000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const data = await deleteDimension(scope,id);
    return Response.json({ success: true, data: data ?? null });
  },
);
