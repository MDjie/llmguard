import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// 克隆策略
export async function POST(
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
      .from('policy_profiles')
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
      .from('policy_profiles')
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
      .from('policy_profiles')
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
      .from('policy_rules')
      .select()
      .eq('policy_id', id);

    if (rules && rules.length > 0) {
      await client.from('policy_rules').insert(
        rules.map((rule) => ({
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
      .from('keyword_categories')
      .select()
      .eq('policy_id', id);

    const categoryIdMap: Record<string, string> = {};

    if (categories && categories.length > 0) {
      for (const cat of categories) {
        const { data: newCat } = await client
          .from('keyword_categories')
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
      .from('keyword_rules')
      .select()
      .eq('policy_id', id);

    if (keywords && keywords.length > 0) {
      await client.from('keyword_rules').insert(
        keywords.map((kw) => ({
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
