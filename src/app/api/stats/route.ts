import { NextResponse } from 'next/server';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { detectionSessions, detectionRecords, riskFindings, detectionDimensions } from '@/lib/db';
import { sql, eq, and, gte, lt } from 'drizzle-orm';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

async function getStats(
  _request: Request,
  _routeContext: unknown,
  apiContext: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(apiContext.principal);
    // 获取总检测次数
    const totalCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(detectionSessions)
      .where(scopePredicate(detectionSessions, scope));
    
    const totalCount = Number(totalCountResult[0]?.count || 0);

    // 获取今日检测次数
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    const todayCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(detectionSessions)
      .where(and(
        gte(detectionSessions.createdAt, todayStart),
        scopePredicate(detectionSessions, scope),
      ));

    const todayCount = Number(todayCountResult[0]?.count || 0);

    // 获取动作分布
    const sessionsData = await db
      .select({ finalAction: detectionSessions.finalAction })
      .from(detectionSessions)
      .where(scopePredicate(detectionSessions, scope));

    const actionDistribution = {
      allow: sessionsData.filter(s => s.finalAction === 'allow').length,
      warn: sessionsData.filter(s => s.finalAction === 'warn').length,
      block: sessionsData.filter(s => s.finalAction === 'block').length,
      mask: sessionsData.filter(s => s.finalAction === 'mask').length,
      rewrite: sessionsData.filter(s => s.finalAction === 'rewrite').length,
    };

    // 获取风险维度分布
    const dimensions = await db
      .select({ code: detectionDimensions.code })
      .from(detectionDimensions)
      .where(and(
        eq(detectionDimensions.enabled, true),
        scopePredicate(detectionDimensions, scope),
      ));

    const findingsData = await db
      .select({ dimension: riskFindings.dimension })
      .from(riskFindings)
      .where(scopePredicate(riskFindings, scope));

    const riskDistribution: Record<string, number> = {};
    for (const dim of dimensions) {
      riskDistribution[dim.code] = findingsData.filter(f => f.dimension === dim.code).length;
    }

    // 获取检测记录统计
    const recordsData = await db
      .select({
        overallScore: detectionRecords.overallScore,
        totalLatencyMs: detectionRecords.totalLatencyMs,
      })
      .from(detectionRecords)
      .where(scopePredicate(detectionRecords, scope));

    const avgScore = recordsData.length > 0
      ? recordsData.reduce((sum, r) => sum + (r.overallScore ? parseFloat(r.overallScore) : 0), 0) / recordsData.length
      : 0;

    const avgLatency = recordsData.length > 0
      ? recordsData.reduce((sum, r) => sum + (r.totalLatencyMs || 0), 0) / recordsData.length
      : 0;

    // 获取最近7天的趋势数据（按动作分类）
    const last7Days = [];
    const trendTodayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(trendTodayStart);
      dayStart.setDate(dayStart.getDate() - i);
      
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      // 按动作分类统计当天数据
      const daySessions = await db
        .select({ finalAction: detectionSessions.finalAction })
        .from(detectionSessions)
        .where(and(
          gte(detectionSessions.createdAt, dayStart),
          lt(detectionSessions.createdAt, dayEnd),
          scopePredicate(detectionSessions, scope),
        ));

      const dayTotal = daySessions.length;
      const dayBlock = daySessions.filter(s => s.finalAction === 'block').length;
      const dayWarn = daySessions.filter(s => s.finalAction === 'warn').length;
      const dayMask = daySessions.filter(s => s.finalAction === 'mask').length;

      // 格式化日期为 YYYY-MM-DD
      const year = dayStart.getFullYear();
      const month = String(dayStart.getMonth() + 1).padStart(2, '0');
      const day = String(dayStart.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      last7Days.push({
        date: dateStr,
        count: dayTotal,
        blockCount: dayBlock,
        warnCount: dayWarn,
        maskCount: dayMask,
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
