import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { documentFindingParamsSchema, updateDocumentFindingSchema } from '@/contracts/http/documents';
import { withApiSecurity } from '@/lib/api-security';
import { ApiProblem } from '@/lib/api-security/problem';
import { db, documentScanFindings, documentScanTasks } from '@/lib/db';
import { requireTenantContext, scopePredicate, type TenantScope } from '@/lib/tenancy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FINDING_RATE_LIMIT = {
  id: 'document-finding',
  windowMs: 60_000,
  maxRequests: 60,
  scope: 'principal' as const,
};

async function assertTaskOwner(
  taskId: string,
  ownerId: string,
  scope: TenantScope,
): Promise<void> {
  const [task] = await db.select({ id: documentScanTasks.id }).from(documentScanTasks).where(and(
    eq(documentScanTasks.id, taskId),
    eq(documentScanTasks.ownerId, ownerId),
    scopePredicate(documentScanTasks, scope),
  )).limit(1);
  if (!task) {
    throw new ApiProblem({ status: 404, code: 'DOCUMENT_TASK_NOT_FOUND', title: 'Not found', detail: 'The document task was not found.' });
  }
}

export const PATCH = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: documentFindingParamsSchema,
    bodySchema: updateDocumentFindingSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: FINDING_RATE_LIMIT,
    maxBodyBytes: 4_096,
    auditEvent: 'document.finding.update',
  },
  async ({ routeContext, body, principal }) => {
    const { id: taskId, findingId } = await (routeContext as {
      params: Promise<{ id: string; findingId: string }>;
    }).params;
    const scope = requireTenantContext(principal);
    await assertTaskOwner(taskId, principal!.subject, scope);

    const updateData: Partial<typeof documentScanFindings.$inferInsert> = {
      status: body.status,
    };
    if (body.status === 'ignored') {
      updateData.ignoreReason = body.ignoreReason;
      updateData.ignoreNote = body.ignoreNote ?? null;
      updateData.ignoredAt = new Date();
      updateData.ignoredBy = principal!.subject;
    } else {
      updateData.ignoreReason = null;
      updateData.ignoreNote = null;
      updateData.ignoredAt = null;
      updateData.ignoredBy = null;
    }

    const [updated] = await db.update(documentScanFindings).set(updateData).where(and(
      eq(documentScanFindings.id, findingId),
      eq(documentScanFindings.taskId, taskId),
      scopePredicate(documentScanFindings, scope),
    )).returning();
    if (!updated) {
      throw new ApiProblem({ status: 404, code: 'DOCUMENT_FINDING_NOT_FOUND', title: 'Not found', detail: 'The document finding was not found.' });
    }
    return NextResponse.json({ success: true, data: updated });
  },
);

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: documentFindingParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: FINDING_RATE_LIMIT,
    maxBodyBytes: 0,
    auditEvent: 'document.finding.read',
  },
  async ({ routeContext, principal }) => {
    const { id: taskId, findingId } = await (routeContext as {
      params: Promise<{ id: string; findingId: string }>;
    }).params;
    const scope = requireTenantContext(principal);
    await assertTaskOwner(taskId, principal!.subject, scope);
    const [finding] = await db.select().from(documentScanFindings).where(and(
      eq(documentScanFindings.id, findingId),
      eq(documentScanFindings.taskId, taskId),
      scopePredicate(documentScanFindings, scope),
    )).limit(1);
    if (!finding) {
      throw new ApiProblem({ status: 404, code: 'DOCUMENT_FINDING_NOT_FOUND', title: 'Not found', detail: 'The document finding was not found.' });
    }
    return NextResponse.json({ success: true, data: finding });
  },
);
