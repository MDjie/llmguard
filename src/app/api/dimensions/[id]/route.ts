import { NextResponse } from 'next/server';
import { query, update, remove, getDb } from '@/lib/db';
import { clearPolicyCache } from '@/lib/detection/dynamic-engine';

// 辅助函数：根据 ID 或 code 获取维度
// 策略：先尝试精确ID查询，再尝试code查询
async function getDimensionByIdOrCode(idOrCode: string) {
  // 先尝试用 id 精确查询
  const idResult = await query('detection_dimensions', {
    filter: { id: idOrCode },
    single: true
  });
  
  if (idResult.data && !Array.isArray(idResult.data)) {
    return idResult;
  }
  
  // id没找到，尝试用 code 查询
  const codeResult = await query('detection_dimensions', {
    filter: { code: idOrCode },
    single: true
  });
  
  return codeResult;
}

// 获取单个维度详情
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const dimensionResult = await getDimensionByIdOrCode(id);

    if (dimensionResult.error || !dimensionResult.data || (Array.isArray(dimensionResult.data) && dimensionResult.data.length === 0)) {
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
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, description, category, weight, priority, enabled, config } = body;

    // 检查维度是否存在
    const existingResult = await getDimensionByIdOrCode(id);

    if (existingResult.error || !existingResult.data || (Array.isArray(existingResult.data) && existingResult.data.length === 0)) {
      return NextResponse.json(
        { success: false, error: '维度不存在' },
        { status: 404 }
      );
    }

    const dimension = existingResult.data;
    const dimensionId = dimension.id;

    // 构建更新数据
    const updateData: Record<string, any> = {};

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
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // 检查维度是否存在
    const existingResult = await getDimensionByIdOrCode(id);

    if (existingResult.error || !existingResult.data || (Array.isArray(existingResult.data) && existingResult.data.length === 0)) {
      return NextResponse.json(
        { success: false, error: '维度不存在' },
        { status: 404 }
      );
    }

    const dimension = existingResult.data;
    const dimensionId = dimension.id;
    const dimensionCode = dimension.code;

    // 系统内置维度不能删除
    if (dimension.isSystem) {
      return NextResponse.json(
        { success: false, error: '系统内置维度不能删除' },
        { status: 400 }
      );
    }

    // 删除关联的 policy_rules（因为没有外键约束）
    const client = getDb();
    const rulesResult = await client
      .from('policy_rules')
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
