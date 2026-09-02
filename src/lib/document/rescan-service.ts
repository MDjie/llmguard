import { and, eq } from 'drizzle-orm';
import { db, documentScanFindings, documentScanTasks } from '@/lib/db';
import { detectDocument } from './detector';
import { highlightEvidenceInHtml, sanitizeHighlightedHtml, type FindingForHighlight } from './highlighter';
import { createChunks, type DocumentChunk } from './parser';
import { scopePredicate } from '@/lib/tenancy';

export interface DocumentRescanResult {
  taskId: string;
  status: 'completed';
  findingsCount: number;
  overallScore: number;
  finalAction: string;
}

export async function rescanDocumentTask(
  task: typeof documentScanTasks.$inferSelect,
): Promise<DocumentRescanResult> {
  const scope = { tenantId: task.tenantId, applicationId: task.applicationId };
  if (!task.extractedText && (!task.parsedChunks || task.parsedChunks.length === 0)) {
    throw new DocumentRescanError('DOCUMENT_CONTENT_MISSING', '没有可用于重新检测的文档内容');
  }

  try {
    await db.transaction(async (transaction) => {
      await transaction.delete(documentScanFindings)
        .where(and(
          eq(documentScanFindings.taskId, task.id),
          scopePredicate(documentScanFindings, scope),
        ));
      await transaction.update(documentScanTasks).set({
        status: 'detecting',
        statusMessage: '正在重新检测...',
        overallScore: null,
        finalAction: null,
        findingsCount: 0,
        errorMessage: null,
        updatedAt: new Date(),
      }).where(and(eq(documentScanTasks.id, task.id), scopePredicate(documentScanTasks, scope)));
    });

    const chunks: DocumentChunk[] = task.parsedChunks?.length
      ? task.parsedChunks.map((chunk) => ({ ...chunk, content: chunk.content ?? '' }))
      : createChunks(task.extractedText ?? '');
    const result = await detectDocument({
      taskId: task.id,
      chunks,
      policyId: task.policyId,
      fileName: task.fileName,
      plainLines: task.plainLines ?? [],
      scope,
    });

    if (task.previewHtml && result.findings.length > 0) {
      const findings: FindingForHighlight[] = result.findings.map((finding) => ({
        id: finding.id,
        evidence: finding.evidence,
        maskedEvidence: finding.maskedEvidence,
        severity: finding.severity,
        locationStatus: finding.locationStatus,
      }));
      const highlighted = highlightEvidenceInHtml({ previewHtml: task.previewHtml, findings });
      await db.update(documentScanTasks).set({
        previewHtml: sanitizeHighlightedHtml(highlighted.highlightedHtml),
        updatedAt: new Date(),
      }).where(and(eq(documentScanTasks.id, task.id), scopePredicate(documentScanTasks, scope)));
    }

    return {
      taskId: task.id,
      status: 'completed',
      findingsCount: result.findings.length,
      overallScore: result.overallScore,
      finalAction: result.finalAction,
    };
  } catch (error) {
    await db.update(documentScanTasks).set({
      status: 'failed',
      errorMessage: '重新检测失败',
      statusMessage: '重新检测失败',
      updatedAt: new Date(),
    }).where(and(eq(documentScanTasks.id, task.id), scopePredicate(documentScanTasks, scope)));
    throw error;
  }
}

export class DocumentRescanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DocumentRescanError';
  }
}
