import type { z } from 'zod';
import { and, desc, inArray } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { exportHistoryQuerySchema } from '@/contracts/http/history';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { exportConditions, EXPORT_RECORD_LIMIT } from '@/lib/data-protection/export-query';
import { csvCell } from '@/lib/csv';
import {
  db,
  detectionRecords,
  detectionSessions,
  riskFindings,
} from '@/lib/db';
import { consumeExportApproval } from '@/lib/data-protection/export-approval';
import { requireTenantContext, scopePredicate, type TenantScope } from '@/lib/tenancy';

type ExportHistoryQuery = z.infer<typeof exportHistoryQuerySchema>;

interface SafeFinding {
  dimension: string;
  score: number | null;
  severity: string | null;
}

interface SafeExportSession {
  id: string;
  inputAction: string | null;
  inputScore: number | null;
  outputAction: string | null;
  outputScore: number | null;
  finalAction: string | null;
  policyId: string | null;
  durationMs: number | null;
  createdAt: string;
  findings: SafeFinding[];
}

async function loadSafeExportSessions(
  scope: TenantScope,
  query: ExportHistoryQuery,
): Promise<SafeExportSession[]> {
  const conditions = exportConditions(scope, query);

  const sessions = await db
    .select({
      id: detectionSessions.id,
      inputAction: detectionSessions.inputAction,
      inputScore: detectionSessions.inputScore,
      outputAction: detectionSessions.outputAction,
      outputScore: detectionSessions.outputScore,
      finalAction: detectionSessions.finalAction,
      policyId: detectionSessions.policyId,
      durationMs: detectionSessions.durationMs,
      createdAt: detectionSessions.createdAt,
    })
    .from(detectionSessions)
    .where(and(...conditions))
    .orderBy(desc(detectionSessions.createdAt))
    .limit(EXPORT_RECORD_LIMIT + 1);
  if (sessions.length > EXPORT_RECORD_LIMIT) throw new ApiProblem({ status: 422, code: 'EXPORT_LIMIT_EXCEEDED', title: '导出范围过大', detail: `单次最多导出 ${EXPORT_RECORD_LIMIT} 条，请缩小筛选范围。` });

  const sessionIds = sessions.map((session) => session.id);
  const records =
    sessionIds.length > 0
      ? await db
          .select({ id: detectionRecords.id, sessionId: detectionRecords.sessionId })
          .from(detectionRecords)
          .where(and(
            inArray(detectionRecords.sessionId, sessionIds),
            scopePredicate(detectionRecords, scope),
          ))
      : [];
  const recordIds = records.map((record) => record.id);
  const findings =
    recordIds.length > 0
      ? await db
          .select({
            recordId: riskFindings.recordId,
            dimension: riskFindings.dimension,
            score: riskFindings.score,
            severity: riskFindings.severity,
          })
          .from(riskFindings)
          .where(and(
            inArray(riskFindings.recordId, recordIds),
            scopePredicate(riskFindings, scope),
          ))
      : [];

  const sessionByRecord = new Map(records.map((record) => [record.id, record.sessionId]));
  const findingsBySession = new Map<string, SafeFinding[]>();
  for (const finding of findings) {
    const sessionId = sessionByRecord.get(finding.recordId);
    if (!sessionId) continue;
    const current = findingsBySession.get(sessionId) ?? [];
    current.push({
      dimension: finding.dimension,
      score: finding.score ? Number(finding.score) : null,
      severity: finding.severity,
    });
    findingsBySession.set(sessionId, current);
  }

  return sessions
    .map((session) => ({
      id: session.id,
      inputAction: session.inputAction,
      inputScore: session.inputScore ? Number(session.inputScore) : null,
      outputAction: session.outputAction,
      outputScore: session.outputScore ? Number(session.outputScore) : null,
      finalAction: session.finalAction,
      policyId: session.policyId,
      durationMs: session.durationMs,
      createdAt: session.createdAt.toISOString(),
      findings: findingsBySession.get(session.id) ?? [],
    }))
    .filter(
      (session) =>
        !query.riskType ||
        session.findings.some((finding) => finding.dimension === query.riskType),
    );
}

function toCsv(sessions: SafeExportSession[]): string {
  const headers = [
    'ID',
    '输入动作',
    '输入风险分',
    '输出动作',
    '输出风险分',
    '最终动作',
    '策略ID',
    '耗时毫秒',
    '风险维度',
    '创建时间',
  ];
  const rows = sessions.map((session) => [
    session.id,
    session.inputAction,
    session.inputScore,
    session.outputAction,
    session.outputScore,
    session.finalAction,
    session.policyId,
    session.durationMs,
    session.findings.map((finding) => finding.dimension).join('|'),
    session.createdAt,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

function toMarkdown(sessions: SafeExportSession[]): string {
  const blocked = sessions.filter((session) => session.finalAction === 'block').length;
  const warned = sessions.filter((session) => session.finalAction === 'warn').length;
  const allowed = sessions.filter((session) => session.finalAction === 'allow').length;
  const dimensionCounts = new Map<string, number>();
  for (const session of sessions) {
    for (const finding of session.findings) {
      dimensionCounts.set(
        finding.dimension,
        (dimensionCounts.get(finding.dimension) ?? 0) + 1,
      );
    }
  }
  const dimensionRows = [...dimensionCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([dimension, count]) => `| ${dimension} | ${count} |`)
    .join('\n');
  const recentRows = sessions
    .slice(0, 20)
    .map(
      (session) =>
        `| ${session.createdAt} | ${session.id} | ${session.finalAction ?? '-'} | ${session.inputScore ?? '-'} |`,
    )
    .join('\n');

  return `# 大模型安全护栏检测报告

## 概览

- 报告生成时间: ${new Date().toISOString()}
- 总检测次数: ${sessions.length}
- 拒绝次数: ${blocked}
- 警告次数: ${warned}
- 放行次数: ${allowed}

## 风险分布

| 风险维度 | 命中次数 |
|---|---:|
${dimensionRows}

## 最近检测记录

| 时间 | 会话 ID | 动作 | 输入风险分 |
|---|---|---|---:|
${recentRows}
`;
}

export const GET = withApiSecurity(
  {
    permission: 'audit:export',
    querySchema: exportHistoryQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    allowedResponseMediaTypes: ['text/csv', 'text/markdown'],
    maxBodyBytes: 0,
    auditEvent: 'history.export',
    rateLimitPolicy: {
      id: 'history-export',
      windowMs: 60_000,
      maxRequests: 10,
      scope: 'principal',
    },
  },
  async ({ query, principal, request }) => {
    const scope = requireTenantContext(principal);
    const sessions = await loadSafeExportSessions(scope, query);
    await consumeExportApproval(
      scope,
      request.headers.get('x-export-approval-id'),
      principal!.subject,
      query,
    );
    const date = new Date().toISOString().slice(0, 10);

    if (query.format === 'csv') {
      return new Response(toCsv(sessions), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="detection_records_${date}.csv"`,
        },
      });
    }
    if (query.format === 'markdown') {
      return new Response(toMarkdown(sessions), {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="detection_report_${date}.md"`,
        },
      });
    }
    return Response.json({
      success: true,
      data: sessions,
      exportedAt: new Date().toISOString(),
      totalCount: sessions.length,
    });
  },
);
