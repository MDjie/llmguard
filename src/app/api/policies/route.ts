import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { clearPolicyCache } from '@/lib/detection/dynamic-engine';

// 获取所有策略列表
export async function GET() {
  try {
    const client = getDb();

    // 获取所有策略配置和检测维度总数
    const { data: profiles, error } = await client
      .from('policy_profiles')
      .select()
      .order('created_at', { ascending: false });

    // 获取启用的检测维度总数
    const { data: dimensions } = await client
      .from('detection_dimensions')
      .select('code')
      .eq('enabled', true);

    const totalDimensions = dimensions?.length || 0;

    if (error) {
      return NextResponse.json(
        { success: false, error: `Failed to fetch policies: ${error}` },
        { status: 500 }
      );
    }

    // 转换字段名从 snake_case 到 camelCase
    const transformPolicy = (p: Record<string, unknown>) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      // Drizzle 返回 camelCase，兼容两种格式
      isDefault: p.isDefault ?? p.is_default,
      isActive: p.isActive ?? p.is_active,
      version: p.version,
      tags: p.tags,
      metadata: p.metadata,
      createdBy: p.createdBy ?? p.created_by,
      createdAt: p.createdAt ?? p.created_at,
      updatedAt: p.updatedAt ?? p.updated_at,
    });

    // 为每个策略获取规则和统计信息
    const policiesWithDetails = await Promise.all(
      (profiles || []).map(async (profile) => {
        const [rulesResult, keywordsResult, categoriesResult] = await Promise.all([
          client.from('policy_rules').select().eq('policy_id', profile.id),
          client.from('keyword_rules').select('id', { count: 'exact', head: true }).eq('policy_id', profile.id),
          client.from('keyword_categories').select('id', { count: 'exact', head: true }).eq('policy_id', profile.id),
        ]);

        return {
          ...transformPolicy(profile),
          rules: rulesResult.data || [],
          stats: {
            totalRules: rulesResult.data?.length || 0,
            totalDimensions,
            configuredDimensions: rulesResult.data?.length || 0,
            totalKeywords: Number(keywordsResult.count) || 0,
            totalCategories: Number(categoriesResult.count) || 0,
          },
        };
      })
    );

    return NextResponse.json({
      success: true,
      data: policiesWithDetails,
    });
  } catch (error) {
    console.error('Error fetching policies:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch policies' },
      { status: 500 }
    );
  }
}

// 创建新策略
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, tags, cloneFrom } = body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json(
        { success: false, error: '策略名称不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 检查名称是否已存在
    const { data: existing } = await client
      .from('policy_profiles')
      .select('id')
      .eq('name', name.trim())
      .single();

    if (existing) {
      return NextResponse.json(
        { success: false, error: '策略名称已存在' },
        { status: 400 }
      );
    }

    let rulesToClone: any[] = [];
    let keywordsToClone: any[] = [];
    let categoriesToClone: any[] = [];

    // 如果是从现有策略克隆
    if (cloneFrom) {
      const [rulesResult, keywordsResult, categoriesResult] = await Promise.all([
        client.from('policy_rules').select().eq('policy_id', cloneFrom),
        client.from('keyword_rules').select().eq('policy_id', cloneFrom),
        client.from('keyword_categories').select().eq('policy_id', cloneFrom),
      ]);
      rulesToClone = rulesResult.data || [];
      keywordsToClone = keywordsResult.data || [];
      categoriesToClone = categoriesResult.data || [];
    }

    // 创建策略配置
    const { data: profile, error: profileError } = await client
      .from('policy_profiles')
      .insert({
        name: name.trim(),
        description: description || '',
        tags: tags || [],
        is_default: false,
        is_active: true,
        version: 1,
      })
      .select()
      .single();

    if (profileError) {
      return NextResponse.json(
        { success: false, error: profileError.message || 'Failed to create policy' },
        { status: 500 }
      );
    }

    // 克隆规则
    if (rulesToClone.length > 0) {
      await client.from('policy_rules').insert(
        rulesToClone.map((rule) => ({
          policy_id: profile.id,
          dimension: rule.dimension,
          enabled: rule.enabled,
          warn_enabled: rule.warn_enabled ?? true,
          block_enabled: rule.block_enabled ?? true,
          warn_threshold: rule.warn_threshold,
          block_threshold: rule.block_threshold,
          auto_mask: rule.auto_mask,
          auto_rewrite: rule.auto_rewrite,
        }))
      );
    } else {
      // 从数据库获取所有启用的检测维度
      const { data: dimensions } = await client
        .from('detection_dimensions')
        .select('code')
        .eq('enabled', true);

      if (dimensions && dimensions.length > 0) {
        // 为每个维度创建默认规则配置
        await client.from('policy_rules').insert(
          dimensions.map((dim: { code: string }) => ({
            policy_id: profile.id,
            dimension: dim.code,
            enabled: true,
            warn_enabled: true,
            block_enabled: true,
            warn_threshold: 50,
            block_threshold: 80,
            auto_mask: dim.code === 'pii_leak', // PII维度默认开启脱敏
            auto_rewrite: false,
          }))
        );
      }
    }

    // 克隆分类和关键词
    if (categoriesToClone.length > 0) {
      const categoryIdMap: Record<string, string> = {};

      for (const cat of categoriesToClone) {
        const { data: newCat } = await client
          .from('keyword_categories')
          .insert({
            policy_id: profile.id,
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

      // 克隆关键词
      if (keywordsToClone.length > 0) {
        await client.from('keyword_rules').insert(
          keywordsToClone.map((kw) => ({
            policy_id: profile.id,
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
    }

    // 创建初始版本快照
    const { data: newRules } = await client
      .from('policy_rules')
      .select()
      .eq('policy_id', profile.id);

    await client.from('policy_versions').insert({
      policy_id: profile.id,
      version: 1,
      snapshot: {
        profile,
        rules: newRules || [],
        keywords: [],
        categories: [],
      },
      change_summary: '初始创建',
      changed_by: 'system',
    });

    return NextResponse.json({
      success: true,
      data: profile,
    });
  } catch (error) {
    console.error('Error creating policy:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create policy' },
      { status: 500 }
    );
  }
}

// 更新策略（基本信息或规则）
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { policyId, name, description, tags, isActive, rules } = body;

    if (!policyId) {
      return NextResponse.json(
        { success: false, error: '策略ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 获取当前策略信息
    const { data: currentPolicy } = await client
      .from('policy_profiles')
      .select()
      .eq('id', policyId)
      .single();

    if (!currentPolicy) {
      return NextResponse.json(
        { success: false, error: '策略不存在' },
        { status: 404 }
      );
    }

    // 更新基本信息
    if (name !== undefined || description !== undefined || tags !== undefined || isActive !== undefined) {
      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (tags !== undefined) updateData.tags = tags;
      if (isActive !== undefined) updateData.is_active = isActive;

      if (Object.keys(updateData).length > 0) {
        const { error } = await client
          .from('policy_profiles')
          .update(updateData)
          .eq('id', policyId);

        if (error) {
          return NextResponse.json(
            { success: false, error: error.message || 'Failed to update policy' },
            { status: 500 }
          );
        }
      }
    }

    // 更新规则（支持新增和更新）
    if (rules && Array.isArray(rules)) {
      const newRules: any[] = [];
      const updateRules: any[] = [];

      rules.forEach((rule: any) => {
        if (!rule.id || rule.is_new) {
          // 新规则（新增维度）需要插入
          newRules.push({
            policy_id: policyId,
            dimension: rule.dimension,
            enabled: rule.enabled ?? true,
            warn_enabled: rule.warn_enabled ?? true,
            block_enabled: rule.block_enabled ?? true,
            warn_threshold: rule.warn_threshold ?? 50,
            block_threshold: rule.block_threshold ?? 80,
            auto_mask: rule.auto_mask ?? false,
            auto_rewrite: rule.auto_rewrite ?? false,
          });
        } else {
          // 已有规则更新
          updateRules.push(rule);
        }
      });

      // 插入新规则
      if (newRules.length > 0) {
        const insertResult = await client.from('policy_rules').insert(newRules);
        if (insertResult.error) {
          console.error('插入新规则失败:', insertResult.error);
        }
      }

      // 更新已有规则
      await Promise.all(
        updateRules.map(async (rule: any) => {
          const { error } = await client
            .from('policy_rules')
            .update({
              enabled: rule.enabled,
              warn_enabled: rule.warn_enabled,
              block_enabled: rule.block_enabled,
              warn_threshold: rule.warn_threshold,
              block_threshold: rule.block_threshold,
              auto_mask: rule.auto_mask,
              auto_rewrite: rule.auto_rewrite,
            })
            .eq('id', rule.id);

          if (error) {
            console.error(`更新规则 ${rule.id} 失败:`, error);
          }
        })
      );

      // 清除策略缓存，确保下次检测使用最新配置
      clearPolicyCache(policyId);
    }

    // 创建版本快照
    const newVersion = currentPolicy.version + 1;
    const [newRules, newKeywords, newCategories] = await Promise.all([
      client.from('policy_rules').select().eq('policy_id', policyId),
      client.from('keyword_rules').select().eq('policy_id', policyId),
      client.from('keyword_categories').select().eq('policy_id', policyId),
    ]);

    const { data: updatedPolicy } = await client
      .from('policy_profiles')
      .select()
      .eq('id', policyId)
      .single();

    await client.from('policy_versions').insert({
      policy_id: policyId,
      version: newVersion,
      snapshot: {
        profile: updatedPolicy,
        rules: newRules.data || [],
        keywords: newKeywords.data || [],
        categories: newCategories.data || [],
      },
      change_summary: '策略更新',
      changed_by: 'user',
    });

    // 更新版本号
    await client
      .from('policy_profiles')
      .update({ version: newVersion })
      .eq('id', policyId);

    return NextResponse.json({
      success: true,
      message: '策略更新成功',
    });
  } catch (error) {
    console.error('Error updating policy:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update policy' },
      { status: 500 }
    );
  }
}

// 删除策略
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: '策略ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 检查是否是默认策略
    const { data: policy } = await client
      .from('policy_profiles')
      .select('is_default, name')
      .eq('id', id)
      .single();

    if (policy?.is_default) {
      return NextResponse.json(
        { success: false, error: '不能删除默认策略' },
        { status: 400 }
      );
    }

    // 删除策略（级联删除规则、关键词、分类、版本）
    const { error } = await client
      .from('policy_profiles')
      .delete()
      .eq('id', id);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message || 'Failed to delete policy' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: '策略删除成功',
    });
  } catch (error) {
    console.error('Error deleting policy:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete policy' },
      { status: 500 }
    );
  }
}
