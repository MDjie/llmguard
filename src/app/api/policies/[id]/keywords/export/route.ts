import { NextRequest, NextResponse } from 'next/server';
import type { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  importKeywordSchema,
  keywordExportQuerySchema,
  policyParamsSchema,
} from '@/contracts/http/policies';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { csvCell } from '@/lib/csv';
import { getDb } from '@/lib/db';

type ImportKeywordInput = z.infer<typeof importKeywordSchema>;

interface ExportKeywordRow {
  keyword: string;
  dimension: string;
  score?: number;
  match_type?: string;
  case_sensitive?: boolean;
  description?: string;
}

// 导出关键词
async function exportKeywords(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const { searchParams } = new URL(request.url);
    const format = searchParams.get('format') || 'json'; // json, csv

    const client = getDb();

    const { data, error } = await client
      .from<ExportKeywordRow>('keyword_rules')
      .select()
      .eq('policy_id', policyId)
      .eq('enabled', true);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    if (format === 'csv') {
      const header = 'keyword,dimension,score,match_type,case_sensitive,description\n';
      const rows = (data || [])
        .map((k) => [
          csvCell(k.keyword),
          csvCell(k.dimension),
          csvCell(k.score),
          csvCell(k.match_type),
          csvCell(k.case_sensitive),
          csvCell(k.description || ''),
        ].join(','))
        .join('\n');

      return new NextResponse(header + rows, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="keywords-${policyId}.csv"`,
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: data || [],
    });
  } catch (error) {
    console.error('Error exporting keywords:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to export keywords' },
      { status: 500 }
    );
  }
}

// 导入关键词
async function importKeywords(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const body = (await request.json()) as ImportKeywordInput;
    const { keywords, categoryId, dimension, mode } = body; // mode: 'merge' | 'replace'

    if (!keywords || !Array.isArray(keywords)) {
      return NextResponse.json(
        { success: false, error: '关键词数据无效' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 替换模式：先删除现有关键词
    if (mode === 'replace') {
      await client
        .from<{ keyword: string }>('keyword_rules')
        .delete()
        .eq('policy_id', policyId);
    }

    // 获取已存在的关键词（合并模式）
    let existingSet = new Set<string>();
    if (mode !== 'replace') {
      const keywordValues = keywords.map((k) => k.keyword);
      const { data: existing } = await client
        .from<{ keyword: string }>('keyword_rules')
        .select('keyword')
        .eq('policy_id', policyId)
        .in('keyword', keywordValues);
      existingSet = new Set(
        (existing || []).map((row) => row.keyword),
      );
    }

    // 插入新关键词
    const toInsert = keywords
      .filter((k) => !existingSet.has(k.keyword))
      .map((k) => ({
        policy_id: policyId,
        category_id: categoryId || k.categoryId || null,
        dimension: dimension || k.dimension || 'prompt_injection',
        keyword: k.keyword,
        score: k.score || 90,
        match_type: k.matchType || k.match_type || 'exact',
        case_sensitive: k.caseSensitive || k.case_sensitive || false,
        enabled: true,
        description: k.description || '',
        tags: k.tags || [],
      }));

    if (toInsert.length > 0) {
      await client.from('keyword_rules').insert(toInsert);
    }

    return NextResponse.json({
      success: true,
      data: {
        inserted: toInsert.length,
        skipped: keywords.length - toInsert.length,
      },
      message: `成功导入 ${toInsert.length} 个关键词`,
    });
  } catch (error) {
    console.error('Error importing keywords:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to import keywords' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'audit:export',
    paramsSchema: policyParamsSchema,
    querySchema: keywordExportQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    allowedResponseMediaTypes: ['text/csv'],
    maxBodyBytes: 0,
    auditEvent: 'keyword.export',
    rateLimitPolicy: {
      id: 'keyword-export',
      windowMs: 60_000,
      maxRequests: 10,
      scope: 'principal',
    },
  },
  exportKeywords,
);

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: importKeywordSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 4 * 1_024 * 1_024,
    auditEvent: 'keyword.import',
    rateLimitPolicy: {
      id: 'keyword-import',
      windowMs: 60_000,
      maxRequests: 5,
      scope: 'principal',
    },
  },
  importKeywords,
);
