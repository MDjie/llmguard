import { and, desc, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, documentScanTasks } from '@/lib/db';
import { formDataWithLimit, withApiSecurity } from '@/lib/api-security';
import { ApiProblem, validationErrors } from '@/lib/api-security/problem';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { documentTaskQuerySchema, documentUploadMetadataSchema } from '@/contracts/http/documents';
import { detectDocument } from '@/lib/document/detector';
import { highlightEvidenceInHtml, sanitizeHighlightedHtml, type FindingForHighlight } from '@/lib/document/highlighter';
import { createChunks, getFileCategory, parseDocument, type DocumentChunk, type PlainLine } from '@/lib/document/parser';
import { UnsafeDocumentUploadError, validateDocumentUpload } from '@/lib/document/upload-security';
import { requireTenantContext, scopePredicate, type TenantScope } from '@/lib/tenancy';
import { policyProfiles } from '@/storage/database/shared/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DOCUMENT_RATE_LIMIT = {
  id: 'document-scan',
  windowMs: 60_000,
  maxRequests: 30,
  scope: 'principal' as const,
};
const DOCUMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MULTIPART_BODY_LIMIT = 52 * 1_024 * 1_024;

function problem(status: number, code: string, detail: string): ApiProblem {
  return new ApiProblem({ status, code, title: 'Document request rejected', detail });
}

function publicTaskMetadata(task: typeof documentScanTasks.$inferSelect) {
  const {
    extractedText: _extractedText,
    parsedChunks: _parsedChunks,
    previewHtml: _previewHtml,
    plainLines: _plainLines,
    ocrResults: _ocrResults,
    errorMessage: _errorMessage,
    ...metadata
  } = task;
  return metadata;
}

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    querySchema: documentTaskQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: DOCUMENT_RATE_LIMIT,
    maxBodyBytes: 0,
    auditEvent: 'document.scan.list',
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const conditions = [
      scopePredicate(documentScanTasks, scope),
      eq(documentScanTasks.ownerId, principal!.subject),
    ];
    if (query.policyId) conditions.push(eq(documentScanTasks.policyId, query.policyId));
    if (query.status) conditions.push(eq(documentScanTasks.status, query.status));
    const where = and(...conditions);

    const tasks = await db.select().from(documentScanTasks).where(where)
      .orderBy(desc(documentScanTasks.createdAt)).limit(query.limit).offset(query.offset);
    const countResult = await db.select({ count: sql<number>`count(*)` })
      .from(documentScanTasks).where(where);
    const total = Number(countResult[0]?.count ?? 0);

    return NextResponse.json({
      success: true,
      data: tasks.map(publicTaskMetadata),
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + tasks.length < total,
      },
    });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'security:operate',
    allowedRequestMediaTypes: ['multipart/form-data'],
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: { id: 'document-scan-upload', windowMs: 60_000, maxRequests: 5, scope: 'principal' },
    maxBodyBytes: MULTIPART_BODY_LIMIT,
    auditEvent: 'document.scan.upload',
  },
  async ({ request, principal }) => {
    const scope = requireTenantContext(principal);
    let taskId: string | null = null;
    try {
      // 有界解析：分块传输无 Content-Length 时，预检不生效，必须在此二次设限
      const formData = await formDataWithLimit(request, MULTIPART_BODY_LIMIT);
      const fileEntry = formData.get('file');
      if (!(fileEntry instanceof File)) {
        throw problem(400, 'DOCUMENT_FILE_REQUIRED', 'A document file is required.');
      }

      const metadataResult = documentUploadMetadataSchema.safeParse({
        policyId: formData.get('policyId'),
        ocrEnabled: formData.get('ocrEnabled') === 'true',
        ocrModel: formData.get('ocrModel') || null,
      });
      if (!metadataResult.success) {
        throw new ApiProblem({
          status: 400,
          code: 'DOCUMENT_METADATA_INVALID',
          title: 'Invalid document metadata',
          detail: 'The document metadata is invalid.',
          errors: validationErrors(metadataResult.error.issues),
        });
      }

      let upload: Awaited<ReturnType<typeof validateDocumentUpload>>;
      try {
        upload = await validateDocumentUpload(fileEntry);
      } catch (error) {
        if (error instanceof UnsafeDocumentUploadError) {
          throw problem(error.code === 'FILE_SIZE_INVALID' ? 413 : 400, error.code, error.message);
        }
        throw error;
      }

      const fileCategory = getFileCategory(upload.extension);
      if (fileCategory === 'unknown') {
        throw problem(400, 'FILE_TYPE_UNSUPPORTED', 'The file type is unsupported.');
      }
      if (fileCategory === 'image') {
        throw problem(501, 'MULTIMODAL_OCR_NOT_CONFIGURED', 'Image OCR is unavailable until a governed multimodal provider is configured.');
      }
      const [policy] = await db.select({ id: policyProfiles.id }).from(policyProfiles).where(and(
        eq(policyProfiles.id, metadataResult.data.policyId),
        scopePredicate(policyProfiles, scope),
      )).limit(1);
      if (!policy) {
        throw problem(404, 'POLICY_NOT_FOUND', 'The selected policy does not exist in this application.');
      }

      const [task] = await db.insert(documentScanTasks).values({
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        ownerId: principal!.subject,
        fileName: fileEntry.name,
        fileType: upload.extension,
        fileSize: upload.size,
        policyId: metadataResult.data.policyId,
        status: 'pending',
        statusMessage: '任务已创建，等待处理',
        ocrEnabled: metadataResult.data.ocrEnabled,
        contentExpiresAt: new Date(Date.now() + DOCUMENT_RETENTION_MS),
      }).returning();
      taskId = task.id;

      const result = await processDocument(task.id, fileEntry, metadataResult.data.policyId, scope);
      return NextResponse.json({ success: true, data: result, message: '文档检测完成' });
    } catch (error) {
      if (taskId) await updateTaskError(taskId, '文档处理失败', scope);
      throw error;
    }
  },
);

async function processDocument(
  taskId: string,
  file: File,
  policyId: string,
  scope: TenantScope,
): Promise<{ taskId: string; status: string; findingsCount: number }> {
  await db.update(documentScanTasks)
    .set({ status: 'parsing', statusMessage: '正在解析文档内容...', updatedAt: new Date() })
    .where(and(eq(documentScanTasks.id, taskId), scopePredicate(documentScanTasks, scope)));

  const parsed = await parseDocument(
    Buffer.from(await file.arrayBuffer()),
    file.name.split('.').pop()?.toLowerCase() ?? '',
  );
  if (!parsed.extractedText.trim()) {
    throw problem(422, 'DOCUMENT_TEXT_EMPTY', file.name.toLowerCase().endsWith('.pdf')
      ? 'No machine-readable text was found in the PDF.'
      : 'No machine-readable text was found in the document.');
  }

  const chunks: DocumentChunk[] = createChunks(parsed.extractedText);
  const plainLines: PlainLine[] = parsed.plainLines;
  await db.update(documentScanTasks).set({
    extractedText: parsed.extractedText,
    previewHtml: parsed.previewHtml,
    plainLines,
    parsedChunks: chunks,
    parseMeta: {
      hasTables: parsed.metadata.hasTables,
      hasImages: parsed.metadata.hasImages,
      totalLines: plainLines.length,
      totalChars: parsed.extractedText.length,
    },
    status: 'detecting',
    statusMessage: `文档解析完成，正在检测 ${chunks.length} 个文本片段...`,
    updatedAt: new Date(),
  }).where(and(eq(documentScanTasks.id, taskId), scopePredicate(documentScanTasks, scope)));

  const result = await detectDocument({
    taskId,
    chunks,
    policyId,
    fileName: file.name,
    plainLines,
    scope,
  });
  if (parsed.previewHtml && result.findings.length > 0) {
    const findings: FindingForHighlight[] = result.findings.map((finding) => ({
      id: finding.id,
      evidence: finding.evidence,
      maskedEvidence: finding.maskedEvidence,
      severity: finding.severity,
      locationStatus: finding.locationStatus,
    }));
    const highlighted = highlightEvidenceInHtml({ previewHtml: parsed.previewHtml, findings });
    await db.update(documentScanTasks).set({
      previewHtml: sanitizeHighlightedHtml(highlighted.highlightedHtml),
      updatedAt: new Date(),
    }).where(and(eq(documentScanTasks.id, taskId), scopePredicate(documentScanTasks, scope)));
  }
  return { taskId, status: 'completed', findingsCount: result.findings.length };
}

async function updateTaskError(taskId: string, message: string, scope: TenantScope): Promise<void> {
  await db.update(documentScanTasks).set({
    status: 'failed',
    errorMessage: message,
    statusMessage: '处理失败',
    updatedAt: new Date(),
  }).where(and(eq(documentScanTasks.id, taskId), scopePredicate(documentScanTasks, scope)));
}
