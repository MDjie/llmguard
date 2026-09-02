import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { whitelistRules, whitelistRulePolicies, detectionDimensions } from '@/lib/db';
import { and, eq, sql } from 'drizzle-orm';
import { safeRegexTest } from '@/lib/detection/safe-regex';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

const testWhitelistSchema = z
  .object({
    policyId: z.string().min(1).max(36).optional(),
    text: z.string().trim().min(1).max(32_768),
    ruleId: z.string().min(1).max(128).optional(),
  })
  .strict();

// 白名单匹配结果
interface WhitelistMatchResult {
  id: string;
  name: string;
  pattern: string;
  matchType: string;
  policyScope: string;
  dimensionScope: string;
  dimensionCodes: string[];
  dimensionNames: string[];
  priority: number;
  effect: string;
  isApplicableToPolicy: boolean;  // 是否对当前策略生效
  notApplicableReason?: string;   // 不生效的原因
}

// 测试白名单规则是否匹配文本
function testMatch(text: string, pattern: string, matchType: string, caseSensitive: boolean): boolean {
  const compareText = caseSensitive ? text : text.toLowerCase();
  const comparePattern = caseSensitive ? pattern : pattern.toLowerCase();

  switch (matchType) {
    case 'exact':
      return compareText === comparePattern;
    case 'contains':
      return compareText.includes(comparePattern);
    case 'prefix':
      return compareText.startsWith(comparePattern);
    case 'suffix':
      return compareText.endsWith(comparePattern);
    case 'regex':
      try {
        return safeRegexTest(text, pattern, caseSensitive);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// POST: 测试白名单
async function testWhitelistRules(
  request: NextRequest,
  _routeContext: unknown,
  apiContext: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(apiContext.principal);
    const body = await request.json();
    const { policyId, text, ruleId } = body;

    if (!text || !text.trim()) {
      return NextResponse.json(
        { success: false, error: '测试文本不能为空' },
        { status: 400 }
      );
    }

    // 获取所有维度
    const dimensions = await db.select().from(detectionDimensions)
      .where(scopePredicate(detectionDimensions, scope));
    const dimensionMap = new Map(dimensions.map(d => [d.code, d.name]));

    // 获取要测试的白名单规则
    let rules;
    if (ruleId) {
      // 只测试指定规则
      rules = await db.select()
        .from(whitelistRules)
        .where(and(
          eq(whitelistRules.id, ruleId),
          scopePredicate(whitelistRules, scope),
        ));
    } else {
      // 获取所有启用的白名单规则
      rules = await db.select()
        .from(whitelistRules)
        .where(and(
          eq(whitelistRules.enabled, true),
          scopePredicate(whitelistRules, scope),
        ))
        .orderBy(sql`${whitelistRules.priority} DESC`);
    }

    // 获取所有策略绑定
    const policyBindings = await db.select().from(whitelistRulePolicies)
      .where(scopePredicate(whitelistRulePolicies, scope));

    // 测试每个白名单规则
    const matchedRules: WhitelistMatchResult[] = [];
    const allDimensionCodes = dimensions.map(d => d.code);

    for (const rule of rules) {
      // 测试是否匹配
      const isMatched = testMatch(text, rule.pattern, rule.matchType, rule.caseSensitive);
      
      if (!isMatched) {
        continue;
      }

      // 获取维度名称
      const dimCodes = (rule.dimensionCodes as string[]) || [];
      const dimNames = dimCodes.map(code => dimensionMap.get(code) || code);

      // 判断是否对当前策略生效
      let isApplicableToPolicy = true;
      let notApplicableReason: string | undefined;

      if (policyId) {
        // 指定了策略，需要判断策略范围
        if (rule.policyScope === 'specific') {
          const bindings = policyBindings.filter(b => b.whitelistRuleId === rule.id);
          const boundPolicyIds = bindings.map(b => b.policyId);
          isApplicableToPolicy = boundPolicyIds.includes(policyId);
          if (!isApplicableToPolicy) {
            notApplicableReason = '该白名单未绑定当前策略';
          }
        }
        // policyScope === 'all' 时对所有策略生效
      }

      // 确定效果描述
      let effect: string;
      if (rule.dimensionScope === 'all') {
        effect = '跳过所有维度的适用普通规则；强制拒绝规则仍执行';
      } else {
        effect = `跳过 ${dimNames.join('、')} 维度的适用普通规则；强制拒绝规则仍执行`;
      }

      matchedRules.push({
        id: rule.id,
        name: rule.name || '未命名白名单',
        pattern: rule.pattern,
        matchType: rule.matchType,
        policyScope: rule.policyScope,
        dimensionScope: rule.dimensionScope,
        dimensionCodes: dimCodes,
        dimensionNames: dimNames,
        priority: rule.priority,
        effect,
        isApplicableToPolicy,
        notApplicableReason,
      });
    }

    // 判断是否命中全局白名单（dimensionScope === 'all' 且对当前策略生效）
    const globalMatched = matchedRules.find(
      r => r.dimensionScope === 'all' && r.isApplicableToPolicy
    );

    // 维度白名单匹配
    const dimensionMatched = matchedRules.filter(
      r => r.dimensionScope === 'specific' && r.isApplicableToPolicy
    );

    // 计算会跳过的维度
    const skippedDimensionCodes = new Set<string>();
    if (globalMatched) {
      // 全部维度都会跳过
      allDimensionCodes.forEach(code => skippedDimensionCodes.add(code));
    } else {
      // 只跳过指定的维度
      for (const rule of dimensionMatched) {
        rule.dimensionCodes.forEach(code => skippedDimensionCodes.add(code));
      }
    }

    // 不会影响的维度
    const notAffectedDimensions = allDimensionCodes
      .filter(code => !skippedDimensionCodes.has(code))
      .map(code => ({
        code,
        name: dimensionMap.get(code) || code,
      }));

    // 构造返回结果
    const result = {
      matched: matchedRules.length > 0,
      text,
      policyId: policyId || null,
      globalMatched: globalMatched ? {
        id: globalMatched.id,
        name: globalMatched.name,
        pattern: globalMatched.pattern,
        matchType: globalMatched.matchType,
        effect: globalMatched.effect,
      } : null,
      dimensionMatched: dimensionMatched.map(r => ({
        id: r.id,
        name: r.name,
        pattern: r.pattern,
        matchType: r.matchType,
        dimensionCodes: r.dimensionCodes,
        dimensionNames: r.dimensionNames,
        effect: r.effect,
      })),
      // 匹配但不生效的白名单
      matchedButNotApplicable: matchedRules
        .filter(r => !r.isApplicableToPolicy)
        .map(r => ({
          id: r.id,
          name: r.name,
          reason: r.notApplicableReason,
        })),
      skippedDimensions: Array.from(skippedDimensionCodes).map(code => ({
        code,
        name: dimensionMap.get(code) || code,
      })),
      notAffectedDimensions,
      mandatoryDenyStillEvaluated: true,
    };

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('测试白名单失败:', error);
    return NextResponse.json(
      { success: false, error: '测试白名单失败' },
      { status: 500 }
    );
  }
}

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    bodySchema: testWhitelistSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'whitelist.test',
    rateLimitPolicy: {
      id: 'whitelist-test',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  testWhitelistRules,
);
