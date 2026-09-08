import { and, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { createWhitelistRuleSchema } from '@/contracts/http/whitelist';
import { ApiProblem } from '@/lib/api-security';
import { clearPolicyCache, getPolicyConfig } from '@/lib/detection/dynamic-engine';
import { loadGovernedPolicyArtifacts } from '@/lib/policy-bundle/governance';
import { db } from '@/storage/database/shared/db';
import { policyProfiles } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';

export async function whitelistTargets(scope: TenantScope, policyIds: readonly string[]) {
  const profiles = await db.select({ id: policyProfiles.id, name: policyProfiles.name }).from(policyProfiles).where(and(
    scopePredicate(policyProfiles, scope), policyIds.length ? inArray(policyProfiles.id, [...policyIds]) : undefined,
  ));
  if (policyIds.some(id => !profiles.some(profile => profile.id === id))) throw new ApiProblem({ status: 404, code: 'WHITELIST_POLICY_NOT_FOUND', title: '策略不可用', detail: '所选策略不存在或不属于当前应用。' });
  const targets: Array<{ id: string; name: string; dimension: string; policyId: string; mandatoryDeny: boolean }> = [];
  for (const profile of profiles) {
    clearPolicyCache(profile.id);
    const config = await getPolicyConfig(profile.id, scope);
    if (!config) continue;
    for (const [dimensionId, rules] of config.rules) {
      const dimension = config.dimensions.find(item => item.id === dimensionId);
      if (!dimension) continue;
      for (const rule of rules.filter(rule => rule.enabled && rule.pattern)) targets.push({ id: rule.id, name: rule.name, dimension: dimension.code, policyId: profile.id, mandatoryDeny: rule.config.mandatoryDeny === true || rule.config.hardBlock === true });
    }
    const governed = await loadGovernedPolicyArtifacts(scope, profile.id);
    for (const rule of governed.keywordRules) targets.push({ id: rule.id, name: rule.id, dimension: rule.riskType, policyId: profile.id, mandatoryDeny: rule.mandatoryDeny === true });
  }
  return targets;
}

export async function validateWhitelistTargets(scope: TenantScope, body: Pick<z.infer<typeof createWhitelistRuleSchema>, 'policyScope' | 'policyIds' | 'targetRuleIds' | 'dimensionCodes'>) {
  const targets = await whitelistTargets(scope, body.policyScope === 'specific' ? body.policyIds : []);
  for (const id of body.targetRuleIds) {
    const matches = targets.filter(target => target.id === id);
    if (!matches.length || matches.some(target => target.mandatoryDeny || !body.dimensionCodes.includes(target.dimension))) throw new ApiProblem({ status: 422, code: 'WHITELIST_TARGET_INVALID', title: '目标规则不可用', detail: '目标已删除、维度不符或属于不可豁免规则，请刷新后重新选择。' });
  }
}
