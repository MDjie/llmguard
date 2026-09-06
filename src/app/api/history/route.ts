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
import { sql, eq, desc, inArray, and, gte, lte, ilike } from 'drizzle-orm';
import type { z } from 'zod';
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
        dimensionName: getDimensionName(f.dimension),
        score: f.score ? Number(f.score) : null,
        severity: f.severity,
        matchedRules: f.matchedRules as string[] || [],
        evidence: [],
        reason: null,
      }));

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
        policyName: '默认策略',
        direction: 'input' as const,
        providerId: session.targetProviderId,
        providerName: '模型',
        modelUsed: '模型',
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

    // 获取关联的检测记录
    const records = await db
      .select()
      .from(detectionRecords)
      .where(and(
        eq(detectionRecords.sessionId, id),
        scopePredicate(detectionRecords, scope),
      ));

    const recordIds = records.map(r => r.id);

    // 删除关联的风险发现
    if (recordIds.length > 0) {
      await db
        .delete(riskFindings)
        .where(and(
          inArray(riskFindings.recordId, recordIds),
          scopePredicate(riskFindings, scope),
        ));
    }

    // 删除关联的检测记录
    await db
      .delete(detectionRecords)
      .where(and(
        eq(detectionRecords.sessionId, id),
        scopePredicate(detectionRecords, scope),
      ));

    // 删除会话
    await db
      .delete(detectionSessions)
      .where(and(
        eq(detectionSessions.id, id),
        scopePredicate(detectionSessions, scope),
      ));

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

// 维度名称映射
function getDimensionName(code: string): string {
  const names: Record<string, string> = {
    prompt_injection: '提示词注入',
    pii_leak: 'PII泄露',
    credential_secret_leak: '凭证泄露',
    malicious_code: '恶意代码',
    violence_hate: '暴力仇恨',
    illegal_content: '非法内容',
    spam_detection: '垃圾信息',
    ad_detection: '广告检测',
    sensitive_compliance: '敏感合规',
    adult_content: '成人内容',
    self_harm: '自残',
    fraud_scam: '欺诈诈骗',
    misinformation: '虚假信息',
    copyright_risk: '版权风险',
    business_sensitive: '商业敏感',
    output_leak: '输出泄露',
  };
  return names[code] || code;
}
