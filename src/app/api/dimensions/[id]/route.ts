import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  emptyQuerySchema,
  idOrCodeParamsSchema,
  jsonObjectResponseSchema,
} from '@/contracts/http/common';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { query, update, remove, getDb } from '@/lib/db';
import { clearPolicyCache } from '@/lib/detection/dynamic-engine';

interface DimensionRow {
  readonly id: string;
  readonly code: string;
  readonly is_system: boolean;
  readonly [key: string]: unknown;
}

const updateDimensionSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(2_000).optional(),
    category: z.string().trim().min(1).max(64).optional(),
    weight: z.number().positive().max(10).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

// 辅助函数：根据 ID 或 code 获取维度
// 策略：先尝试精确ID查询，再尝试code查询
async function getDimensionByIdOrCode(idOrCode: string) {
  // 先尝试用 id 精确查询
  const idResult = await query<DimensionRow>('detection_dimensions', {
    filter: { id: idOrCode },
    single: true
  });
  
  if (idResult.data) {
    return idResult;
  }
  
  // id没找到，尝试用 code 查询
  const codeResult = await query<DimensionRow>('detection_dimensions', {
    filter: { code: idOrCode },
    single: true
  });
  
  return codeResult;
}

// 获取单个维度详情
async function getDimension(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const dimensionResult = await getDimensionByIdOrCode(id);

    if (dimensionResult.error || !dimensionResult.data) {
      return NextResponse.json(
        { success: false, error: '维度不存在' },
        { status: 404 }
      );
    }

    const dimension = dimensionResult.data;
    const dimensionId = dimension.id;

    // 获取该维度的规则
    const rulesResult = await query('detection_rules', {
      filter: { dimensionId },
      order: { column: 'priority', ascending: false }
    });

    const rules = rulesResult.data || [];

    // 获取规则组
    const ruleGroupsResult = await query('rule_groups', {
      filter: { dimensionId }
    });
    
    const ruleGroups = ruleGroupsResult.data || [];

    return NextResponse.json({
      success: true,
      data: {
        ...dimension,
        rules,
        ruleGroups,
        ruleCount: rules.length
      }
    });
  } catch (error) {
    console.error('获取维度详情失败:', error);
    return NextResponse.json(
      { success: false, error: '获取维度详情失败' },
      { status: 500 }
    );
  }
}

// 更新维度
async function updateDimension(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, category, weight, priority, enabled, config } = body;

    // 检查维度是否存在
    const existingResult = await getDimensionByIdOrCode(id);

    if (existingResult.error || !existingResult.data) {
      return NextResponse.json(
        { success: false, error: '维度不存在' },
        { status: 404 }
      );
    }

    const dimension = existingResult.data;
    const dimensionId = dimension.id;

    // 构建更新数据
    const updateData: Record<string, unknown> = {};

    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (weight !== undefined) updateData.weight = weight;
    if (priority !== undefined) updateData.priority = priority;
    if (enabled !== undefined) updateData.enabled = enabled;
    if (config !== undefined) updateData.config = config;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { success: false, error: '没有要更新的字段' },
        { status: 400 }
      );
    }

    const updated = await update('detection_dimensions', dimensionId, updateData);

    // 清除检测缓存
    clearPolicyCache();

    return NextResponse.json({ success: true, data: updated.data });
  } catch (error) {
    console.error('更新维度失败:', error);
    return NextResponse.json(
      { success: false, error: '更新维度失败' },
      { status: 500 }
    );
  }
}

// 删除维度
async function deleteDimension(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // 检查维度是否存在
    const existingResult = await getDimensionByIdOrCode(id);

    if (existingResult.error || !existingResult.data) {
      return NextResponse.json(
        { success: false, error: '维度不存在' },
        { status: 404 }
      );
    }

    const dimension = existingResult.data;
    const dimensionId = dimension.id;
    const dimensionCode = dimension.code;

    // 系统内置维度不能删除
    if (dimension.is_system) {
      return NextResponse.json(
        { success: false, error: '系统内置维度不能删除' },
        { status: 400 }
      );
    }

    // 删除关联的 policy_rules（因为没有外键约束）
    const client = getDb();
    const rulesResult = await client
      .from<{ id: string }>('policy_rules')
      .select('id')
      .eq('dimension', dimensionCode);

    if (rulesResult.data && rulesResult.data.length > 0) {
      // 使用 Drizzle 直接删除（getDb 不支持批量 delete without condition）
      const { sql, db } = await import('@/lib/db');
      await db.execute(sql`DELETE FROM policy_rules WHERE dimension = ${dimensionCode}`);
    }

    await remove('detection_dimensions', dimensionId);

    // 清除检测缓存
    clearPolicyCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('删除维度失败:', error);
    return NextResponse.json(
      { success: false, error: '删除维度失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: idOrCodeParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.read',
    rateLimitPolicy: {
      id: 'dimension-read',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  getDimension,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: idOrCodeParamsSchema,
    bodySchema: updateDimensionSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'dimension.update',
    rateLimitPolicy: {
      id: 'dimension-update',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  updateDimension,
);

export const DELETE = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: idOrCodeParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.delete',
    rateLimitPolicy: {
      id: 'dimension-delete',
      windowMs: 60_000,
      maxRequests: 10,
      scope: 'principal',
    },
  },
  deleteDimension,
);
