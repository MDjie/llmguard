import { NextRequest, NextResponse } from 'next/server';
import {
  emptyQuerySchema,
  jsonObjectResponseSchema,
} from '@/contracts/http/common';
import {
  policyParamsSchema,
  updatePolicyMetadataSchema,
} from '@/contracts/http/policies';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { getDb, transactionalCompatibilityHandler, afterCompatibilityCommit } from '@/lib/db';
import { clearPolicyCache } from '@/lib/detection/dynamic-engine';

// camelCase 转 snake_case
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

// 转换对象键名从 camelCase 到 snake_case
function toSnakeCase<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(toSnakeCase) as T;
  if (typeof obj !== 'object') return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = camelToSnake(key);
    result[snakeKey] = toSnakeCase(value);
  }
  return result as T;
}

// 获取单个策略详情
async function getPolicy(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const client = getDb();

    // 获取策略基本信息
    const { data: profile, error } = await client
      .from('policy_profiles')
      .select()
      .eq('id', id)
      .single();

    if (error || !profile) {
      return NextResponse.json(
        { success: false, error: '策略不存在' },
        { status: 404 }
      );
    }

    // 获取规则、关键词分类、关键词、检测维度
    const [rulesResult, categoriesResult, keywordsResult, versionsResult, dimensionsResult] = await Promise.all([
      client.from('policy_rules').select().eq('policy_id', id),
      client.from('keyword_categories').select().eq('policy_id', id).order('priority'),
      client.from('keyword_rules').select().eq('policy_id', id).order('created_at', { ascending: false }),
      client.from('policy_versions').select().eq('policy_id', id).order('version', { ascending: false }).limit(10),
      client.from('detection_dimensions').select().eq('enabled', true),
    ]);

    // 合并 policy_rules 和 detection_dimensions，确保所有维度都显示
    const existingRules = rulesResult.data || [];
    const allDimensions = dimensionsResult.data || [];

    // 为没有 policy_rule 的维度创建默认配置(未开启), 并按"加入时间"倒序排列,
    // 让后新增/后配置的检测维度排在最上面。已配置维度用 policy_rules.created_at
    // (加入本策略的时间), 未配置(新)维度用 detection_dimensions.created_at。
    // 注意: 必须在 toSnakeCase() 之前读取时间值 —— 它返回的 Date 对象没有可枚举
    // 属性, toSnakeCase() 递归会把 Date 序列化成空对象 {}。
    const mergeEntries: Array<{ row: Record<string, unknown>; ts: number }> =
      allDimensions.map((dim: Record<string, unknown>) => {
        const existingRule = existingRules.find(
          (r: Record<string, unknown>) => r.dimension === dim.code
        );
        if (existingRule) {
          const rawTs = existingRule.created_at ?? existingRule.createdAt;
          const ts = rawTs ? new Date(rawTs as string | number | Date).getTime() : 0;
          const row = toSnakeCase(existingRule) as Record<string, unknown>;
          return { row, ts: Number.isFinite(ts) ? ts : 0 };
        }
        // 新维度没有配置时返回默认配置, 默认未开启(enabled: false)
        const rawTs = dim.created_at ?? dim.createdAt;
        const ts = rawTs ? new Date(rawTs as string | number | Date).getTime() : 0;
        return {
          row: {
            id: null,
            policy_id: id,
            dimension: dim.code,
            dimension_name: dim.name,
            enabled: false,
            warn_enabled: true,
            block_enabled: true,
            warn_threshold: 50,
            block_threshold: 80,
            auto_mask: dim.code === 'pii_leak',
            auto_rewrite: false,
            is_new: true, // 标记为新增维度
          },
          ts: Number.isFinite(ts) ? ts : 0,
        };
      });

    // 后加入/后创建的排最上面(时间倒序)
    mergeEntries.sort((a, b) => b.ts - a.ts);
    const rulesWithDimensions = mergeEntries.map((entry) => entry.row);

    // 转换字段名从 snake_case 到 camelCase
    const transformPolicy = (p: Record<string, unknown>) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      // Drizzle 返回 camelCase，所以直接使用
      isDefault: p.isDefault ?? p.is_default,
      isActive: p.isActive ?? p.is_active,
      version: p.version,
      tags: p.tags,
      config: p.config,
      createdBy: p.createdBy ?? p.created_by,
      createdAt: p.createdAt ?? p.created_at,
      updatedAt: p.updatedAt ?? p.updated_at,
    });

    return NextResponse.json({
      success: true,
      data: {
        ...transformPolicy(profile),
        rules: rulesWithDimensions,
        categories: categoriesResult.data || [],
        keywords: keywordsResult.data || [],
        versions: versionsResult.data || [],
        stats: {
          totalRules: existingRules.length,
          totalKeywords: keywordsResult.data?.length || 0,
          totalCategories: categoriesResult.data?.length || 0,
          totalDimensions: allDimensions.length,
          newDimensions: allDimensions.length - existingRules.length,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching policy:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch policy' },
      { status: 500 }
    );
  }
}

// 更新策略基本信息
async function updatePolicyMetadata(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, tags } = body;

    const client = getDb();

    // 检查名称是否重复
    if (name) {
      const { data: existing } = await client
        .from('policy_profiles')
        .select('id')
        .eq('name', name)
        .neq('id', id)
        .single();

      if (existing) {
        return NextResponse.json(
          { success: false, error: '策略名称已存在' },
          { status: 400 }
        );
      }
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (tags !== undefined) updateData.tags = tags;

    const { error } = await client
      .from('policy_profiles')
      .update(updateData)
      .eq('id', id);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    // 清除检测缓存
    afterCompatibilityCommit(() => clearPolicyCache(id));

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

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: policyParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'policy.read',
    rateLimitPolicy: {
      id: 'policy-read',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  getPolicy,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: updatePolicyMetadataSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'policy.metadata.update',
    rateLimitPolicy: {
      id: 'policy-metadata-update',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  transactionalCompatibilityHandler(updatePolicyMetadata),
);
