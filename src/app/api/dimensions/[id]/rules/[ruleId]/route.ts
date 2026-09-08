import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { jsonObjectResponseSchema, dimensionRuleParamsSchema } from '@/contracts/http/common';
import { updateRuleSchema } from '@/contracts/http/dimensions';
import { findRule, updateRule, deleteRule } from '@/lib/dimensions/service';

export const runtime = 'nodejs';

export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: dimensionRuleParamsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.findRule',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--rules--rule-d--route-ts-get', windowMs: 60000, maxRequests: 120, scope: 'principal' },
  },
  async ({ principal, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id, ruleId } = await (routeContext as { params: Promise<{ id: string; ruleId: string }> }).params;
    const data = await findRule(scope,id,ruleId);
    return Response.json({ success: true, data });
  },
);

export const PUT = withApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: dimensionRuleParamsSchema,
    bodySchema: updateRuleSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1024,
    auditEvent: 'dimension.updateRule',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--rules--rule-d--route-ts-put', windowMs: 60000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal, body, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id, ruleId } = await (routeContext as { params: Promise<{ id: string; ruleId: string }> }).params;
    const data = await updateRule(scope,id,ruleId,body);
    return Response.json({ success: true, data });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: dimensionRuleParamsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.deleteRule',
    rateLimitPolicy: { id: 'src-app-api-dimensions--id--rules--rule-d--route-ts-delete', windowMs: 60000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal, routeContext }) => {
    const scope = requireTenantContext(principal);
    const { id, ruleId } = await (routeContext as { params: Promise<{ id: string; ruleId: string }> }).params;
    const data = await deleteRule(scope,id,ruleId);
    return Response.json({ success: true, data: data ?? null });
  },
);
