import { NextResponse } from 'next/server';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { detectionSessions, detectionRecords, riskFindings, detectionDimensions } from '@/lib/db';
import { sql, eq, and, gte, lt } from 'drizzle-orm';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

function localDayString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function getStats(
  _request: Request,
  _routeContext: unknown,
  apiContext: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(apiContext.principal);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 6);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    // 总量/今日量/动作分布合并为一条数据库端聚合查询
    const [summary] = await db
      .select({
        total: sql<number>`count(*)`,
        today: sql<number>`count(*) filter (where ${detectionSessions.createdAt} >= ${todayStart})`,
        allow: sql<number>`count(*) filter (where ${detectionSessions.finalAction} = 'allow')`,
        warn: sql<number>`count(*) filter (where ${detectionSessions.finalAction} = 'warn')`,
        block: sql<number>`count(*) filter (where ${detectionSessions.finalAction} = 'block')`,
        mask: sql<number>`count(*) filter (where ${detectionSessions.finalAction} = 'mask')`,
        rewrite: sql<number>`count(*) filter (where ${detectionSessions.finalAction} = 'rewrite')`,
      })
      .from(detectionSessions)
      .where(scopePredicate(detectionSessions, scope));

    const totalCount = Number(summary?.total ?? 0);
    const todayCount = Number(summary?.today ?? 0);
    const actionDistribution = {
      allow: Number(summary?.allow ?? 0),
      warn: Number(summary?.warn ?? 0),
      block: Number(summary?.block ?? 0),
      mask: Number(summary?.mask ?? 0),
      rewrite: Number(summary?.rewrite ?? 0),
    };

    // 获取风险维度分布（数据库端 GROUP BY，仅回传每个维度的计数）
    const dimensions = await db
      .select({ code: detectionDimensions.code })
      .from(detectionDimensions)
      .where(and(
        eq(detectionDimensions.enabled, true),
        scopePredicate(detectionDimensions, scope),
      ));

    const findingsByDimension = await db
      .select({ dimension: riskFindings.dimension, count: sql<number>`count(*)` })
      .from(riskFindings)
      .where(scopePredicate(riskFindings, scope))
      .groupBy(riskFindings.dimension);

    const findingsCount = new Map(
      findingsByDimension.map((row) => [row.dimension, Number(row.count)]),
    );
    const riskDistribution: Record<string, number> = {};
    for (const dim of dimensions) {
      riskDistribution[dim.code] = findingsCount.get(dim.code) ?? 0;
    }

    // 检测记录均值（数据库端 AVG；coalesce 保持空值按 0 计入的既有口径）
    const [recordStats] = await db
      .select({
        avgScore: sql<number>`coalesce(avg(coalesce(${detectionRecords.overallScore}, 0)), 0)`,
        avgLatency: sql<number>`coalesce(avg(coalesce(${detectionRecords.totalLatencyMs}, 0)), 0)`,
      })
      .from(detectionRecords)
      .where(scopePredicate(detectionRecords, scope));

    const avgScore = Number(recordStats?.avgScore ?? 0);
    const avgLatency = Number(recordStats?.avgLatency ?? 0);

    // 最近7天趋势：单条 GROUP BY 聚合（按服务器本地时区的日边界分桶），
    // 缺失日期在内存中补零
    const trendRows = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${detectionSessions.createdAt} at time zone ${timeZone}), 'YYYY-MM-DD')`,
        total: sql<number>`count(*)`,
        block: sql<number>`count(*) filter (where ${detectionSessions.finalAction} = 'block')`,
        warn: sql<number>`count(*) filter (where ${detectionSessions.finalAction} = 'warn')`,
        mask: sql<number>`count(*) filter (where ${detectionSessions.finalAction} = 'mask')`,
      })
      .from(detectionSessions)
      .where(and(
        gte(detectionSessions.createdAt, weekStart),
        lt(detectionSessions.createdAt, tomorrowStart),
        scopePredicate(detectionSessions, scope),
      ))
      .groupBy(sql`1`);

    const trendByDay = new Map(trendRows.map((row) => [row.day, row]));
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(todayStart);
      dayStart.setDate(dayStart.getDate() - i);
      const dateStr = localDayString(dayStart);
      const row = trendByDay.get(dateStr);
      last7Days.push({
        date: dateStr,
        count: Number(row?.total ?? 0),
        blockCount: Number(row?.block ?? 0),
        warnCount: Number(row?.warn ?? 0),
        maskCount: Number(row?.mask ?? 0),
      });
    }

    // 计算拦截率
    const blockRate = totalCount > 0
      ? ((actionDistribution.block / totalCount) * 100).toFixed(2)
      : '0.00';

    return NextResponse.json({
      success: true,
      data: {
        totalDetections: totalCount,
        todayDetections: todayCount,
        actionDistribution,
        riskDistribution,
        avgScore: Math.round(avgScore * 100) / 100,
        avgLatency: Math.round(avgLatency),
        blockRate: `${blockRate}%`,
        trend: last7Days,
      },
    });
  } catch (error) {
    console.error('获取统计数据失败:', error);
    return NextResponse.json(
      { success: false, error: '获取统计数据失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'history:read',
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'statistics.read',
    rateLimitPolicy: {
      id: 'statistics-read',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getStats,
);
