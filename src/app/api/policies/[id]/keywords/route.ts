import { NextRequest, NextResponse } from 'next/server';
import type { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  createKeywordSchema,
  keywordDeleteQuerySchema,
  keywordQuerySchema,
  policyParamsSchema,
  updateKeywordSchema,
} from '@/contracts/http/policies';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { getDb } from '@/lib/db';
import { prepareKeywordCreateRow } from '@/lib/policy/keyword-batch';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// 获取策略的关键词列表
async function getKeywords(
  request: NextRequest,
  routeContext: { params: Promise<{ id: string }> },
  apiContext: { query: z.infer<typeof keywordQuerySchema> },
) {
  try {
    const { id: policyId } = await routeContext.params;
    const { categoryId, dimension, search, page, pageSize } = apiContext.query;

    const client = getDb();

    let query = client
      .from('keyword_rules')
      .select('*, category:keyword_categories(id, name)', { count: 'exact' })
      .eq('policy_id', policyId);

    if (categoryId) {
      query = query.eq('category_id', categoryId);
    }
    if (dimension) {
      query = query.eq('dimension', dimension);
    }
    if (search) {
      query = query.ilike('keyword', `%${escapeLike(search)}%`);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        items: data || [],
        total: count || 0,
        page,
        pageSize,
        totalPages: Math.ceil((count || 0) / pageSize),
      },
    });
  } catch (error) {
    console.error('Error fetching keywords:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch keywords' },
      { status: 500 }
    );
  }
}

// 添加关键词
async function createKeyword(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const body = await request.json();
    const { keyword, dimension, categoryId, score, matchType, caseSensitive, description, tags } = body;

    if (!keyword || !dimension) {
      return NextResponse.json(
        { success: false, error: '关键词和维度不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 检查关键词是否已存在
    const { data: existing } = await client
      .from('keyword_rules')
      .select('id')
      .eq('policy_id', policyId)
      .eq('keyword', keyword)
      .single();

    if (existing) {
      return NextResponse.json(
        { success: false, error: '关键词已存在' },
        { status: 400 }
      );
    }

    const { data, error } = await client
      .from('keyword_rules')
      .insert(prepareKeywordCreateRow({
        policyId,
        categoryId,
        dimension,
        item: { keyword, score, matchType, caseSensitive, description, tags },
      }))
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
    console.error('Error creating keyword:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create keyword' },
      { status: 500 }
    );
  }
}

// 更新关键词
async function updateKeyword(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const body = await request.json();
    const { keywordId, keyword, dimension, categoryId, score, matchType, caseSensitive, enabled, description, tags } = body;

    if (!keywordId) {
      return NextResponse.json(
        { success: false, error: '关键词ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    const updateData: Record<string, unknown> = {};
    if (keyword !== undefined) updateData.keyword = keyword;
    if (dimension !== undefined) updateData.dimension = dimension;
    if (categoryId !== undefined) updateData.category_id = categoryId;
    if (score !== undefined) updateData.score = score;
    if (matchType !== undefined) updateData.match_type = matchType;
    if (caseSensitive !== undefined) updateData.case_sensitive = caseSensitive;
    if (enabled !== undefined) updateData.enabled = enabled;
    if (description !== undefined) updateData.description = description;
    if (tags !== undefined) updateData.tags = tags;

    const { error } = await client
      .from('keyword_rules')
      .update(updateData)
      .eq('id', keywordId)
      .eq('policy_id', policyId);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: '关键词更新成功',
    });
  } catch (error) {
    console.error('Error updating keyword:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update keyword' },
      { status: 500 }
    );
  }
}

// 删除关键词
async function deleteKeyword(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const { searchParams } = new URL(request.url);
    const keywordId = searchParams.get('keywordId');

    if (!keywordId) {
      return NextResponse.json(
        { success: false, error: '关键词ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    const { error } = await client
      .from('keyword_rules')
      .delete()
      .eq('id', keywordId)
      .eq('policy_id', policyId);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: '关键词删除成功',
    });
  } catch (error) {
    console.error('Error deleting keyword:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete keyword' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: policyParamsSchema,
    querySchema: keywordQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'keyword.list',
    rateLimitPolicy: {
      id: 'keyword-list',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  getKeywords,
);

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: createKeywordSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'keyword.create',
    rateLimitPolicy: {
      id: 'keyword-create',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  createKeyword,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: updateKeywordSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'keyword.update',
    rateLimitPolicy: {
      id: 'keyword-update',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  updateKeyword,
);

export const DELETE = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    querySchema: keywordDeleteQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'keyword.delete',
    rateLimitPolicy: {
      id: 'keyword-delete',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  deleteKeyword,
);
