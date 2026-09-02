import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { jsonObjectResponseSchema, emptyQuerySchema } from '@/contracts/http/common';
import { documentTaskParamsSchema } from '@/contracts/http/documents';
import { withApiSecurity } from '@/lib/api-security';
import { ApiProblem } from '@/lib/api-security/problem';
import { db, documentScanTasks } from '@/lib/db';
import { DocumentRescanError, rescanDocumentTask } from '@/lib/document/rescan-service';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiSecurity(
  {
    permission: 'security:operate',
    paramsSchema: documentTaskParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: { id: 'document-rescan', windowMs: 60_000, maxRequests: 10, scope: 'principal' },
    maxBodyBytes: 0,
    auditEvent: 'document.scan.rescan',
  },
  async ({ routeContext, principal }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const scope = requireTenantContext(principal);
    const [task] = await db.select().from(documentScanTasks).where(and(
      eq(documentScanTasks.id, id),
      eq(documentScanTasks.ownerId, principal!.subject),
      scopePredicate(documentScanTasks, scope),
    )).limit(1);
    if (!task) {
      throw new ApiProblem({ status: 404, code: 'DOCUMENT_TASK_NOT_FOUND', title: 'Not found', detail: 'The document task was not found.' });
    }
    try {
      const result = await rescanDocumentTask(task);
      return NextResponse.json({ success: true, data: result, message: '重新检测完成' });
    } catch (error) {
      if (error instanceof DocumentRescanError) {
        throw new ApiProblem({ status: 409, code: error.code, title: 'Document rescan rejected', detail: error.message });
      }
      throw error;
    }
  },
);
