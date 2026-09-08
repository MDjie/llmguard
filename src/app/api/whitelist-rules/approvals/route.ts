import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { validateWhitelistTargets } from '@/lib/policy-governance/whitelist';
import { clearPolicyCache } from '@/lib/detection/dynamic-engine';
import { db } from '@/storage/database/shared/db';
import { whitelistRules, whitelistRulePolicies } from '@/storage/database/shared/schema';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
export const PATCH = withApiSecurity({ permission: 'policy:approve', bodySchema: z.object({ id: z.string().min(1).max(36), expectedRevision: z.number().int().positive(), decision: z.enum(['approved', 'rejected']) }).strict(), responseSchema: jsonObjectResponseSchema, maxBodyBytes: 4096, auditEvent: 'whitelist.approval.decide', rateLimitPolicy: { id: 'whitelist-approve', windowMs: 60_000, maxRequests: 30, scope: 'principal' } }, async ({ body, principal }) => {
  const scope = requireTenantContext(principal);
  const result = await db.transaction(async tx => {
    const [rule] = await tx.select().from(whitelistRules).where(and(scopePredicate(whitelistRules, scope), eq(whitelistRules.id, body.id))).for('update');
    if (!rule) throw new ApiProblem({ status: 404, code: 'WHITELIST_NOT_FOUND', title: '规则不存在', detail: '规则不存在或不可访问。' });
    if (rule.approvalStatus !== 'pending' || rule.revision !== body.expectedRevision || !rule.expiresAt || rule.expiresAt.getTime() <= Date.now()) throw new ApiProblem({ status: 409, code: 'WHITELIST_REVISION_CONFLICT', title: '审批不可用', detail: '规则已变更、已审批或已过期，请刷新。' });
    if (!rule.proposedBy || rule.proposedBy === principal!.subject) throw new ApiProblem({ status: 403, code: 'WHITELIST_SELF_APPROVAL_DENIED', title: '需要独立审批', detail: '当前提案人不能审批自己的规则；旧规则须重新提交具名草稿。' });
    const bindings = await tx.select().from(whitelistRulePolicies).where(and(scopePredicate(whitelistRulePolicies, scope), eq(whitelistRulePolicies.whitelistRuleId, rule.id)));
    if (body.decision === 'approved') await validateWhitelistTargets(scope, { policyScope: rule.policyScope === 'specific' ? 'specific' : 'all', policyIds: bindings.map(item => item.policyId), targetRuleIds: rule.targetRuleIds, dimensionCodes: rule.dimensionCodes ?? [] });
    const [updated] = await tx.update(whitelistRules).set({ approvalStatus: body.decision, approvedBy: principal!.subject, approvedAt: new Date(), enabled: body.decision === 'approved', revision: rule.revision + 1, updatedAt: new Date() }).where(eq(whitelistRules.id, rule.id)).returning();
    return updated;
  });
  clearPolicyCache();
  return Response.json({ success: true, data: result, policyBindingChanged: false });
});
