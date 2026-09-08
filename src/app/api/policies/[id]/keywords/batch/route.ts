import { NextRequest, NextResponse } from 'next/server';
import type { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { batchKeywordSchema, policyParamsSchema } from '@/contracts/http/policies';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { getDb, transactionalCompatibilityHandler } from '@/lib/db';
import { prepareKeywordBatchRows } from '@/lib/policy/keyword-batch';

type BatchKeywordInput = z.infer<typeof batchKeywordSchema>;

// 批量添加关键词
async function batchCreateKeywords(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const body = (await request.json()) as BatchKeywordInput;
    const { keywords, categoryId, dimension } = body;

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return NextResponse.json(
        { success: false, error: '关键词列表不能为空' },
        { status: 400 }
      );
    }

    if (!dimension) {
      return NextResponse.json(
        { success: false, error: '维度不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 获取已存在的关键词
    const keywordValues = [...new Set(keywords.map((keyword) =>
      typeof keyword === 'string' ? keyword : keyword.keyword,
    ))];
    const { data: existing } = await client
      .from<{ keyword: string }>('keyword_rules')
      .select('keyword')
      .eq('policy_id', policyId)
      .in('keyword', keywordValues);

    const existingSet = new Set(
      (existing || []).map((row) => row.keyword),
    );

    const prepared = prepareKeywordBatchRows({
      policyId,
      categoryId,
      dimension,
      keywords,
      existingKeywords: existingSet,
    });
    const toInsert = prepared.rows;

    if (toInsert.length === 0) {
      return NextResponse.json({
        success: true,
        data: { inserted: 0, skipped: prepared.skipped },
        message: '所有关键词已存在',
      });
    }

    const { error } = await client
      .from('keyword_rules')
      .insert(toInsert);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: { inserted: toInsert.length, skipped: prepared.skipped },
      message: `成功添加 ${toInsert.length} 个关键词`,
    });
  } catch (error) {
    console.error('Error batch adding keywords:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to batch add keywords' },
      { status: 500 }
    );
  }
}

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: batchKeywordSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 2 * 1_024 * 1_024,
    auditEvent: 'keyword.batch-create',
    rateLimitPolicy: {
      id: 'keyword-batch-create',
      windowMs: 60_000,
      maxRequests: 10,
      scope: 'principal',
    },
  },
  transactionalCompatibilityHandler(batchCreateKeywords),
);
