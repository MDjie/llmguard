import { NextRequest, NextResponse } from 'next/server';
import {
  emptyQuerySchema,
  jsonObjectResponseSchema,
} from '@/contracts/http/common';
import {
  createKeywordCategorySchema,
  keywordCategoryDeleteQuerySchema,
  policyParamsSchema,
  updateKeywordCategorySchema,
} from '@/contracts/http/policies';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { getDb, transactionalCompatibilityHandler } from '@/lib/db';

// 获取策略的关键词分类列表
async function getKeywordCategories(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const client = getDb();

    const { data, error } = await client
      .from('keyword_categories')
      .select()
      .eq('policy_id', policyId)
      .order('priority');

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    // 获取每个分类的关键词数量
    const categoriesWithCount = await Promise.all(
      (data || []).map(async (cat: Record<string, unknown>) => {
        const { count } = await client
          .from('keyword_rules')
          .select('id', { count: 'exact', head: true })
          .eq('category_id', cat.id);

        return {
          ...cat,
          keywordCount: count || 0,
        };
      })
    );

    return NextResponse.json({
      success: true,
      data: categoriesWithCount,
    });
  } catch (error) {
    console.error('Error fetching keyword categories:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch categories' },
      { status: 500 }
    );
  }
}

// 创建关键词分类
async function createKeywordCategory(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const body = await request.json();
    const { name, dimension, description, priority } = body;

    if (!name || !dimension) {
      return NextResponse.json(
        { success: false, error: '分类名称和维度不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    const { data, error } = await client
      .from('keyword_categories')
      .insert({
        policy_id: policyId,
        name,
        dimension,
        description: description || '',
        priority: priority || 100,
        enabled: true,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('Error creating keyword category:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create category' },
      { status: 500 }
    );
  }
}

// 更新关键词分类
async function updateKeywordCategory(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const body = await request.json();
    const { categoryId, name, dimension, description, priority, enabled } = body;

    if (!categoryId) {
      return NextResponse.json(
        { success: false, error: '分类ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (dimension !== undefined) updateData.dimension = dimension;
    if (description !== undefined) updateData.description = description;
    if (priority !== undefined) updateData.priority = priority;
    if (enabled !== undefined) updateData.enabled = enabled;

    const { error } = await client
      .from('keyword_categories')
      .update(updateData)
      .eq('id', categoryId)
      .eq('policy_id', policyId);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: '分类更新成功',
    });
  } catch (error) {
    console.error('Error updating keyword category:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update category' },
      { status: 500 }
    );
  }
}

// 删除关键词分类
async function deleteKeywordCategory(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const { searchParams } = new URL(request.url);
    const categoryId = searchParams.get('categoryId');

    if (!categoryId) {
      return NextResponse.json(
        { success: false, error: '分类ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 删除分类（关键词的category_id会自动设为null）
    const { error } = await client
      .from('keyword_categories')
      .delete()
      .eq('id', categoryId)
      .eq('policy_id', policyId);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: '分类删除成功',
    });
  } catch (error) {
    console.error('Error deleting keyword category:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete category' },
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
    auditEvent: 'keyword-category.list',
    rateLimitPolicy: {
      id: 'keyword-category-list',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getKeywordCategories,
);

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: createKeywordCategorySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 32 * 1_024,
    auditEvent: 'keyword-category.create',
    rateLimitPolicy: {
      id: 'keyword-category-create',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  transactionalCompatibilityHandler(createKeywordCategory),
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: updateKeywordCategorySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 32 * 1_024,
    auditEvent: 'keyword-category.update',
    rateLimitPolicy: {
      id: 'keyword-category-update',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  transactionalCompatibilityHandler(updateKeywordCategory),
);

export const DELETE = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    querySchema: keywordCategoryDeleteQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'keyword-category.delete',
    rateLimitPolicy: {
      id: 'keyword-category-delete',
      windowMs: 60_000,
      maxRequests: 20,
      scope: 'principal',
    },
  },
  transactionalCompatibilityHandler(deleteKeywordCategory),
);
