import { NextRequest, NextResponse } from 'next/server';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { clonePolicySchema, policyParamsSchema } from '@/contracts/http/policies';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { getDb } from '@/lib/db';

interface CloneRuleRow {
  dimension: string;
  enabled?: boolean;
  warn_threshold?: number;
  block_threshold?: number;
  auto_mask?: boolean;
  auto_rewrite?: boolean;
}

interface CloneKeywordRow {
  category_id?: string | null;
  dimension: string;
  keyword: string;
  score?: number;
  match_type?: string;
  case_sensitive?: boolean;
  enabled?: boolean;
  description?: string;
  tags?: string[];
}

interface ClonePolicyRow {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly tags?: readonly string[] | null;
}

interface CloneCategoryRow {
  readonly id: string;
  readonly name: string;
  readonly dimension: string;
  readonly description?: string | null;
  readonly priority?: number;
  readonly enabled?: boolean;
}

// 克隆策略
async function clonePolicy(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name } = body;

    if (!name) {
      return NextResponse.json(
        { success: false, error: '新策略名称不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 获取原策略
    const { data: sourcePolicy, error: sourceError } = await client
      .from<ClonePolicyRow>('policy_profiles')
      .select()
      .eq('id', id)
      .single();

    if (sourceError || !sourcePolicy) {
      return NextResponse.json(
        { success: false, error: '源策略不存在' },
        { status: 404 }
      );
    }

    // 检查名称是否已存在
    const { data: existing } = await client
      .from<{ id: string }>('policy_profiles')
      .select('id')
      .eq('name', name)
      .single();

    if (existing) {
      return NextResponse.json(
        { success: false, error: '策略名称已存在' },
        { status: 400 }
      );
    }

    // 创建新策略
    const { data: newPolicy, error: createError } = await client
      .from<ClonePolicyRow>('policy_profiles')
      .insert({
        name,
        description: `${sourcePolicy.description} (克隆自 ${sourcePolicy.name})`,
        tags: sourcePolicy.tags || [],
        is_default: false,
        is_active: true,
        version: 1,
      })
      .select()
      .single();

    if (createError || !newPolicy) {
      return NextResponse.json(
        { success: false, error: createError?.message || '创建策略失败' },
        { status: 500 }
      );
    }

    // 克隆规则
    const { data: rules } = await client
      .from<CloneRuleRow>('policy_rules')
      .select()
      .eq('policy_id', id);

    const sourceRules = rules ?? [];
    if (sourceRules.length > 0) {
      await client.from('policy_rules').insert(
        sourceRules.map((rule) => ({
          policy_id: newPolicy.id,
          dimension: rule.dimension,
          enabled: rule.enabled,
          warn_threshold: rule.warn_threshold,
          block_threshold: rule.block_threshold,
          auto_mask: rule.auto_mask,
          auto_rewrite: rule.auto_rewrite,
        }))
      );
    }

    // 克隆分类和关键词
    const { data: categories } = await client
      .from<CloneCategoryRow>('keyword_categories')
      .select()
      .eq('policy_id', id);

    const categoryIdMap: Record<string, string> = {};

    if (categories && categories.length > 0) {
      for (const cat of categories) {
        const { data: newCat } = await client
          .from<{ id: string }>('keyword_categories')
          .insert({
            policy_id: newPolicy.id,
            name: cat.name,
            dimension: cat.dimension,
            description: cat.description,
            priority: cat.priority,
            enabled: cat.enabled,
          })
          .select()
          .single();

        if (newCat) {
          categoryIdMap[cat.id] = newCat.id;
        }
      }
    }

    const { data: keywords } = await client
      .from<CloneKeywordRow>('keyword_rules')
      .select()
      .eq('policy_id', id);

    const sourceKeywords = keywords ?? [];
    if (sourceKeywords.length > 0) {
      await client.from('keyword_rules').insert(
        sourceKeywords.map((kw) => ({
          policy_id: newPolicy.id,
          category_id: kw.category_id ? categoryIdMap[kw.category_id] : null,
          dimension: kw.dimension,
          keyword: kw.keyword,
          score: kw.score,
          match_type: kw.match_type || 'exact',
          case_sensitive: kw.case_sensitive || false,
          enabled: kw.enabled,
          description: kw.description,
          tags: kw.tags || [],
        }))
      );
    }

    return NextResponse.json({
      success: true,
      data: newPolicy,
      message: '策略克隆成功',
    });
  } catch (error) {
    console.error('Error cloning policy:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to clone policy' },
      { status: 500 }
    );
  }
}

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: clonePolicySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 16 * 1_024,
    auditEvent: 'policy.clone',
    rateLimitPolicy: {
      id: 'policy-clone',
      windowMs: 60_000,
      maxRequests: 10,
      scope: 'principal',
    },
  },
  clonePolicy,
);
