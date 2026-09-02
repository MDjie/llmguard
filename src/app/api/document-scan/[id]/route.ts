import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { documentTaskParamsSchema } from '@/contracts/http/documents';
import { withApiSecurity } from '@/lib/api-security';
import { ApiProblem } from '@/lib/api-security/problem';
import { db, documentScanFindings, documentScanTasks } from '@/lib/db';
import { mayReadRawContent } from '@/lib/data-protection/content';
import { requireTenantContext, scopePredicate, type TenantScope } from '@/lib/tenancy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TASK_RATE_LIMIT = {
  id: 'document-task',
  windowMs: 60_000,
  maxRequests: 60,
  scope: 'principal' as const,
};

async function ownedTask(id: string, ownerId: string, scope: TenantScope) {
  const [task] = await db.select().from(documentScanTasks).where(and(
    eq(documentScanTasks.id, id),
    eq(documentScanTasks.ownerId, ownerId),
    scopePredicate(documentScanTasks, scope),
  )).limit(1);
  if (!task) {
    throw new ApiProblem({
      status: 404,
      code: 'DOCUMENT_TASK_NOT_FOUND',
      title: 'Not found',
      detail: 'The document task was not found.',
    });
  }
  return task;
}

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: documentTaskParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: TASK_RATE_LIMIT,
    maxBodyBytes: 0,
    auditEvent: 'document.scan.read',
  },
  async ({ routeContext, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const scope = requireTenantContext(principal);
    const task = await ownedTask(id, principal!.subject, scope);
    const findings = await db.select().from(documentScanFindings)
      .where(and(
        eq(documentScanFindings.taskId, id),
        scopePredicate(documentScanFindings, scope),
      ))
      .orderBy(desc(documentScanFindings.score));

    const stats = {
      totalFindings: findings.length,
      bySeverity: {
        critical: findings.filter((item) => item.severity === 'critical').length,
        high: findings.filter((item) => item.severity === 'high').length,
        medium: findings.filter((item) => item.severity === 'medium').length,
        low: findings.filter((item) => item.severity === 'low').length,
      },
      byStatus: {
        open: findings.filter((item) => item.status === 'open').length,
        accepted: findings.filter((item) => item.status === 'accepted').length,
        ignored: findings.filter((item) => item.status === 'ignored').length,
      },
      byAction: {
        allow: findings.filter((item) => item.action === 'allow').length,
        warn: findings.filter((item) => item.action === 'warn').length,
        mask: findings.filter((item) => item.action === 'mask').length,
        rewrite: findings.filter((item) => item.action === 'rewrite').length,
        block: findings.filter((item) => item.action === 'block').length,
      },
      byDimension: {} as Record<string, { count: number; dimensionName: string; maxScore: number }>,
    };
    for (const finding of findings) {
      const code = finding.dimensionCode || 'unknown';
      const dimension = stats.byDimension[code] ?? {
        count: 0,
        dimensionName: finding.dimensionName || '未知维度',
        maxScore: 0,
      };
      dimension.count += 1;
      dimension.maxScore = Math.max(dimension.maxScore, finding.score);
      stats.byDimension[code] = dimension;
    }

    const canReadRaw = mayReadRawContent(principal!);
    const visibleTask = canReadRaw ? task : {
      ...task,
      extractedText: null,
      previewHtml: null,
      parsedChunks: [],
      plainLines: [],
      ocrResults: [],
    };
    const visibleFindings = canReadRaw ? findings : findings.map((finding) => ({
      ...finding,
      evidence: [],
      maskedEvidence: [],
      reason: null,
      suggestion: null,
      ignoreNote: null,
    }));
    return NextResponse.json({
      success: true,
      data: { task: visibleTask, findings: visibleFindings, stats },
    });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: documentTaskParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: TASK_RATE_LIMIT,
    maxBodyBytes: 0,
    auditEvent: 'document.scan.delete',
  },
  async ({ routeContext, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const scope = requireTenantContext(principal);
    await ownedTask(id, principal!.subject, scope);
    await db.delete(documentScanTasks).where(and(
      eq(documentScanTasks.id, id),
      eq(documentScanTasks.ownerId, principal!.subject),
      scopePredicate(documentScanTasks, scope),
    ));
    return NextResponse.json({ success: true, message: '任务已删除' });
  },
);
