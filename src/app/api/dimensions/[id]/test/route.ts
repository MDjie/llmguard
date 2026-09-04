import { NextResponse } from 'next/server';
import { z } from 'zod';
import { idOrCodeParamsSchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { query } from '@/lib/db';
import { safeRegexMatches, safeRegexTest } from '@/lib/detection/safe-regex';

interface RuleRecord {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly pattern?: string;
  readonly match_type?: string;
  readonly case_sensitive?: boolean;
  readonly score?: number;
  readonly confidence?: unknown;
}

interface DimensionRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly weight: string | number;
}

const testDimensionSchema = z
  .object({
    text: z.string().min(1).max(32_768),
  })
  .strict();

// 规则匹配函数
function matchRule(text: string, rule: RuleRecord): boolean {
  const searchText = rule.case_sensitive ? text : text.toLowerCase();
  const pattern = rule.case_sensitive ? rule.pattern : rule.pattern?.toLowerCase();

  if (!pattern) return false;

  switch (rule.match_type) {
    case 'exact':
      return searchText === pattern;
    case 'contains':
      return searchText.includes(pattern);
    case 'prefix':
      return searchText.startsWith(pattern);
    case 'suffix':
      return searchText.endsWith(pattern);
    case 'regex':
      try {
        return safeRegexTest(text, pattern, rule.case_sensitive === true);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// 计算维度评分
function calculateDimensionScore(
  matchedRules: RuleRecord[],
  dimensionWeight: number
): number {
  if (matchedRules.length === 0) return 0;

  // score 以 decimal 字符串形式(如 '90.00')返回,统一转成数字再比较,
  // 避免 '90.00' !== 90 导致最高分规则被重复计入 extraScore。
  const ruleScores = matchedRules.map(r => Number(r.score) || 0);

  // 取最高分
  const maxRuleScore = Math.max(...ruleScores, 0);

  // 其他规则衰减累加
  const extraScore = ruleScores
    .filter(s => s !== maxRuleScore)
    .reduce((sum, s) => sum + s * 0.2, 0);

  // 加权计算
  const finalScore = (maxRuleScore + extraScore) * dimensionWeight;

  // 限制在0-100
  return Math.min(Math.max(finalScore, 0), 100);
}

// 测试维度检测
async function testDimension(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { text } = body;

    if (!text) {
      return NextResponse.json(
        { success: false, error: '测试文本不能为空' },
        { status: 400 }
      );
    }

    // 获取维度信息
    const dimensionResult = await query<DimensionRecord>('detection_dimensions', {
      filter: { id },
      single: true
    });

    if (dimensionResult.error || !dimensionResult.data) {
      return NextResponse.json(
        { success: false, error: '维度不存在' },
        { status: 404 }
      );
    }

    const dimension = dimensionResult.data;

    // 获取该维度的所有启用规则
    const rulesResult = await query<RuleRecord>('detection_rules', {
      filter: { dimensionId: id, enabled: true },
      order: { column: 'priority', ascending: false }
    });

    const rules = rulesResult.data ?? [];

    // 执行规则匹配
    const matchedRules: RuleRecord[] = [];
    const matchedEvidence: string[] = [];

    for (const rule of rules) {
      if (rule.pattern && matchRule(text, rule)) {
        matchedRules.push(rule);
        // 提取匹配的证据
        if (rule.match_type === 'regex') {
          try {
            const matches = safeRegexMatches(
              text,
              rule.pattern,
              rule.case_sensitive === true,
            );
            matchedEvidence.push(...matches.slice(0, 3).map((match) => match.raw));
          } catch {
            // 忽略无效正则
          }
        } else if (rule.pattern) {
          matchedEvidence.push(rule.pattern);
        }
      }
    }

    // 计算评分
    const dimensionWeight = typeof dimension.weight === 'number'
      ? dimension.weight
      : Number.parseFloat(dimension.weight) || 1.0;
    const score = calculateDimensionScore(matchedRules, dimensionWeight);

    return NextResponse.json({
      success: true,
      data: {
        dimension: {
          id: dimension.id,
          code: dimension.code,
          name: dimension.name,
          weight: dimensionWeight
        },
        text,
        score: Math.round(score),
        matchedRules: matchedRules.map(r => ({
          id: r.id,
          name: r.name,
          type: r.type,
          pattern: r.pattern,
          score: r.score,
          confidence: r.confidence
        })),
        evidence: [...new Set(matchedEvidence)], // 去重
        ruleCount: rules.length,
        matchedCount: matchedRules.length
      }
    });
  } catch (error) {
    console.error('测试维度失败:', error);
    return NextResponse.json(
      { success: false, error: '测试维度失败' },
      { status: 500 }
    );
  }
}

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: idOrCodeParamsSchema,
    bodySchema: testDimensionSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'dimension.test',
    rateLimitPolicy: {
      id: 'dimension-test',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  testDimension,
);
