import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { jsonObjectResponseSchema, idOrCodeParamsSchema } from '@/contracts/http/common';
import { createRuleSchema } from '@/contracts/http/dimensions';
import { dimensionDetail, createRule } from '@/lib/dimensions/service';

export const runtime = 'nodejs';

export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: idOrCodeParamsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.dimensionDetail',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--rules-route-ts-get', windowMs: 60000, maxRequests: 120, scope: 'principal' },
  },
  async ({ principal, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const data = await dimensionDetail(scope,id).then(value=>({items:value.rules,total:value.rules.length,ruleGroups:value.ruleGroups}));
    return Response.json({ success: true, data });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: idOrCodeParamsSchema,
    bodySchema: createRuleSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1024,
    auditEvent: 'dimension.createRule',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--rules-route-ts-post', windowMs: 60000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal, body, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const data = await createRule(scope,id,body);
    return Response.json({ success: true, data });
  },
);
