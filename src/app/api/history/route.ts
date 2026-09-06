import { NextResponse } from 'next/server';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  historyDeleteQuerySchema,
  historyQuerySchema,
} from '@/contracts/http/history';
import {
  withApiSecurity,
  type AuthenticatedPrincipal,
} from '@/lib/api-security';
import { db } from '@/lib/db';
import { detectionSessions, detectionRecords, riskFindings } from '@/lib/db';
import { llmProviders, policyProfiles } from '@/storage/database/shared/schema';
import { sql, eq, desc, inArray, and, gte, lte, ilike } from 'drizzle-orm';
import type { z } from 'zod';
import { dimensionLabel } from '@/lib/dimension-labels';
import { requireTenantContext, scopePredicate, type TenantScope } from '@/lib/tenancy';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function getHistory(
  query: z.infer<typeof historyQuerySchema>,
  principal: AuthenticatedPrincipal,
  scope: TenantScope,
) {
  try {
    const { page, limit, action, search, dimension, startDate, endDate } = query;
    const offset = (page - 1) * limit;

    // 所有过滤条件（动作/搜索/维度）前置进 SQL，
    // 使分页与总数基于同一组条件，保证每页条数与 total 一致
    const conditions = [scopePredicate(detectionSessions, scope)];
    if (!principal.permissions.includes('audit:read')) {
      conditions.push(eq(detectionSessions.userId, principal.subject));
    }
    if (action && action !== 'all') {
      conditions.push(eq(detectionSessions.finalAction, action));
    }
    if (search) {
      conditions.push(ilike(detectionSessions.id, `%${escapeLike(search)}%`));
    }
    if (dimension && dimension !== 'all') {
      const sessionIdsWithDimension = db
        .select({ id: detectionRecords.sessionId })
        .from(detectionRecords)
        .innerJoin(riskFindings, eq(riskFindings.recordId, detectionRecords.id))
        .where(and(
          eq(riskFindings.dimension, dimension),
          scopePredicate(detectionRecords, scope),
          scopePredicate(riskFindings, scope),
        ));
      conditions.push(inArray(detectionSessions.id, sessionIdsWithDimension));
    }
    if (startDate) {
      conditions.push(gte(detectionSessions.createdAt, new Date(startDate)));
    }
    if (endDate) {
      // 设置结束日期为当天的最后一秒
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      conditions.push(lte(detectionSessions.createdAt, end));
    }
    const where = and(...conditions);

    // 查询总数（与列表使用同一组过滤条件）
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(detectionSessions)
      .where(where);

    const total = Number(countResult[0]?.count || 0);

    // 查询会话数据
    const sessions = await db
      .select()
      .from(detectionSessions)
      .where(where)
      .orderBy(desc(detectionSessions.createdAt))
      .limit(limit)
      .offset(offset);

    // 获取所有会话ID
    const sessionIds = sessions.map(s => s.id);
    
    // 查询关联的检测记录
    let records: typeof detectionRecords.$inferSelect[] = [];
    if (sessionIds.length > 0) {
      records = await db
        .select()
        .from(detectionRecords)
        .where(and(
          inArray(detectionRecords.sessionId, sessionIds),
          scopePredicate(detectionRecords, scope),
        ));
    }

    // 获取所有记录ID
    const recordIds = records.map(r => r.id);
    
    // 查询关联的风险发现
    let findings: typeof riskFindings.$inferSelect[] = [];
    if (recordIds.length > 0) {
      findings = await db
        .select()
        .from(riskFindings)
        .where(and(
          inArray(riskFindings.recordId, recordIds),
          scopePredicate(riskFindings, scope),
        ));
    }

    // 构建记录ID到findings的映射
    const findingsByRecordId = new Map<string, typeof riskFindings.$inferSelect[]>();
    for (const finding of findings) {
      const existing = findingsByRecordId.get(finding.recordId) || [];
      existing.push(finding);
      findingsByRecordId.set(finding.recordId, existing);
    }

    // 构建会话ID到记录的映射
    const recordsBySessionId = new Map<string, typeof detectionRecords.$inferSelect[]>();
    for (const record of records) {
      const existing = recordsBySessionId.get(record.sessionId) || [];
      existing.push(record);
      recordsBySessionId.set(record.sessionId, existing);
    }

    // 批量取本页涉及的策略与提供商名称（替代硬编码的“默认策略/模型”占位）
    const policyIds = [...new Set(sessions.map(s => s.policyId).filter((id): id is string => Boolean(id)))];
    const providerIds = [...new Set(sessions.map(s => s.targetProviderId).filter((id): id is string => Boolean(id)))];
    const [policies, providers] = await Promise.all([
      policyIds.length > 0
        ? db.select({ id: policyProfiles.id, name: policyProfiles.name })
            .from(policyProfiles)
            .where(and(inArray(policyProfiles.id, policyIds), scopePredicate(policyProfiles, scope)))
        : Promise.resolve([]),
      providerIds.length > 0
        ? db.select({
            id: llmProviders.id,
            name: llmProviders.displayName,
            model: llmProviders.defaultModel,
          }).from(llmProviders)
            .where(and(inArray(llmProviders.id, providerIds), scopePredicate(llmProviders, scope)))
        : Promise.resolve([]),
    ]);
    const policyNames = new Map(policies.map(p => [p.id, p.name]));
    const providerInfo = new Map(providers.map(p => [p.id, p]));

    // 组装最终数据
    const resultSessions = sessions.map(session => {
      const sessionRecords = recordsBySessionId.get(session.id) || [];
      const inputRecord = sessionRecords.find(r => r.direction === 'input');
      const outputRecord = sessionRecords.find(r => r.direction === 'output');
      
      // 合并输入和输出的findings
      const inputFindings = inputRecord ? (findingsByRecordId.get(inputRecord.id) || []) : [];
      const outputFindings = outputRecord ? (findingsByRecordId.get(outputRecord.id) || []) : [];
      
      const allFindings = [...inputFindings, ...outputFindings].map(f => ({
        dimension: f.dimension,
        dimensionName: dimensionLabel(f.dimension),
        score: f.score ? Number(f.score) : null,
        severity: f.severity,
        matchedRules: f.matchedRules as string[] || [],
        evidence: [],
        reason: null,
      }));

      const provider = session.targetProviderId ? providerInfo.get(session.targetProviderId) : undefined;

      return {
        id: session.id,
        inputText: null,
        outputText: null,
        contentStored: Boolean(
          session.userPrompt || session.mockModelOutput || session.finalResponse,
        ),
        inputScore: session.inputScore ? Number(session.inputScore) : null,
        outputScore: session.outputScore ? Number(session.outputScore) : null,
        action: session.finalAction,
        inputAction: session.inputAction,
        outputAction: session.outputAction,
        policyId: session.policyId,
        policyName: session.policyId ? policyNames.get(session.policyId) ?? null : null,
        direction: 'input' as const,
        providerId: session.targetProviderId,
        providerName: provider?.name ?? null,
        modelUsed: provider?.model ?? null,
        latencyMs: session.durationMs,
        findings: allFindings,
        hasRisk: allFindings.length > 0,
        riskLevel: allFindings.some(f => f.severity === 'high') ? 'high' 
                  : allFindings.some(f => f.severity === 'medium') ? 'medium' 
                  : allFindings.length > 0 ? 'low' : 'none',
        createdAt: session.createdAt?.toISOString(),
        // 白名单命中信息
        whitelistMatched: session.whitelistMatched ? (typeof session.whitelistMatched === 'string' ? JSON.parse(session.whitelistMatched) : session.whitelistMatched) : null,
        skippedDimensions: session.skippedDimensions ? (typeof session.skippedDimensions === 'string' ? JSON.parse(session.skippedDimensions) : session.skippedDimensions) : [],
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        sessions: resultSessions,
        pagination: {
          page,
          limit,
          total: total.toString(),
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('获取历史记录失败:', error);
    return NextResponse.json(
      { success: false, error: '获取历史记录失败' },
      { status: 500 }
    );
  }
}

async function deleteHistory(id: string, scope: TenantScope) {
  try {
    if (!id) {
      return NextResponse.json(
        { success: false, error: '缺少会话ID' },
        { status: 400 }
      );
    }

    // 级联删除（detection_records/risk_findings 的 FK 均为 onDelete: cascade）
    // + 事务包裹，避免中途失败留下孤儿数据
    await db.transaction(async (transaction) => {
      await transaction
        .delete(detectionSessions)
        .where(and(
          eq(detectionSessions.id, id),
          scopePredicate(detectionSessions, scope),
        ));
    });

    return NextResponse.json({ success: true, message: '删除成功' });
  } catch (error) {
    console.error('删除会话失败:', error);
    return NextResponse.json(
      { success: false, error: '删除失败' },
      { status: 500 }
    );
  }
}

export const GET = withApiSecurity(
  {
    permission: 'history:read',
    querySchema: historyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'history.list',
    rateLimitPolicy: {
      id: 'history-list',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  async ({ query, principal }) => {
    if (!principal) {
      throw new Error('Authenticated principal missing after authorization');
    }
    return getHistory(query, principal, requireTenantContext(principal));
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'history:manage',
    querySchema: historyDeleteQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'history.delete',
    rateLimitPolicy: {
      id: 'history-delete',
      windowMs: 60_000,
      maxRequests: 20,
      scope: 'principal',
    },
  },
  async ({ query, principal }) => deleteHistory(query.id, requireTenantContext(principal)),
);
