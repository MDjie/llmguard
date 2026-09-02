import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { getDb } from '@/lib/db';

const querySchema = z
  .object({
    days: z.coerce.number().int().min(0).max(3_650).default(30),
    action: z.enum(['all', 'allow', 'warn', 'block', 'mask', 'rewrite']).optional(),
  })
  .strict();

// GET - 获取导出统计信息
async function getExportStats(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '30');
    const action = searchParams.get('action');

    const client = getDb();

    let query = client
      .from('detection_sessions')
      .select('id, createdAt, finalAction', { count: 'exact' });

    // 时间筛选
    if (days > 0) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      query = query.gte('createdAt', startDate);
    }

    // 动作筛选
    if (action && action !== 'all') {
      query = query.eq('finalAction', action);
    }

    const { count, error } = await query;

    if (error) {
      throw error;
    }

    // 计算日期范围描述
    let dateRangeText = '全部';
    if (days > 0) {
      if (days === 7) dateRangeText = '最近 7 天';
      else if (days === 30) dateRangeText = '最近 30 天';
      else if (days === 90) dateRangeText = '最近 90 天';
      else dateRangeText = `最近 ${days} 天`;
    }

    return NextResponse.json({
      success: true,
      data: {
        totalRecords: count || 0,
        dateRange: dateRangeText,
      },
    });
  } catch (error) {
    console.error('获取导出统计失败:', error);
    return NextResponse.json(
      { success: false, error: '获取统计信息失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'audit:export',
    querySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'export.statistics.read',
    rateLimitPolicy: {
      id: 'export-statistics-read',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  getExportStats,
);
