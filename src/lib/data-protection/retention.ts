import { and, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { canonicalJson } from '@/lib/policy-bundle';
import { db } from '@/storage/database/shared/db';
import {
  agentTraces,
  dataDeletionProofs,
  detectionRecords,
  detectionSessions,
  documentScanFindings,
  documentScanTasks,
  judgeModelInvocations,
  riskFindings,
} from '@/storage/database/shared/schema';
import {
  buildDeletionProof,
  lineageObjectIdDigest,
} from './lineage';

export interface RetentionPurgeResult {
  documents: number;
  documentFindings: number;
  sessions: number;
  records: number;
  findings: number;
  agentTraces: number;
  judgeInvocations: number;
  deletionProofId: string | null;
}

export function rawContentRetentionDays(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(environment.RAW_CONTENT_RETENTION_DAYS ?? 7);
  if (!Number.isInteger(value) || value < 1 || value > 3_650) {
    throw new Error('RAW_CONTENT_RETENTION_DAYS must be an integer between 1 and 3650');
  }
  return value;
}

export function retentionCutoff(now = new Date(), days = rawContentRetentionDays()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
}

export async function purgeExpiredContent(
  now = new Date(),
  batchSize = 500,
): Promise<RetentionPurgeResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new Error('batchSize must be an integer between 1 and 5000');
  }
  const cutoff = retentionCutoff(now);
  const expiredDocuments = await db.select({ id: documentScanTasks.id })
    .from(documentScanTasks)
    .where(lte(documentScanTasks.contentExpiresAt, now))
    .limit(batchSize);
  const documentIds = expiredDocuments.map((item) => item.id);
  const expiredSessions = await db.select({ id: detectionSessions.id })
    .from(detectionSessions)
    .where(and(
      lte(detectionSessions.createdAt, cutoff),
      or(
        isNotNull(detectionSessions.userPrompt),
        isNotNull(detectionSessions.mockModelOutput),
        isNotNull(detectionSessions.finalResponse),
        isNotNull(detectionSessions.inputSummary),
        isNotNull(detectionSessions.outputSummary),
      ),
    ))
    .limit(batchSize);
  const sessionIds = expiredSessions.map((item) => item.id);
  const records = sessionIds.length
    ? await db.select({ id: detectionRecords.id }).from(detectionRecords)
      .where(inArray(detectionRecords.sessionId, sessionIds))
    : [];
  const recordIds = records.map((item) => item.id);

  return db.transaction(async (transaction) => {
    const purgedDocuments = documentIds.length
      ? await transaction.update(documentScanTasks).set({
          extractedText: null,
          parsedChunks: [],
          ocrResults: [],
          previewHtml: null,
          plainLines: [],
          parseMeta: {},
          contentExpiresAt: null,
          updatedAt: now,
        }).where(inArray(documentScanTasks.id, documentIds)).returning({ id: documentScanTasks.id })
      : [];
    const purgedDocumentFindings = documentIds.length
      ? await transaction.update(documentScanFindings).set({
          evidence: null,
          maskedEvidence: null,
          reason: null,
          suggestion: null,
          ignoreNote: null,
        }).where(inArray(documentScanFindings.taskId, documentIds)).returning({ id: documentScanFindings.id })
      : [];
    const purgedSessions = sessionIds.length
      ? await transaction.update(detectionSessions).set({
          userPrompt: null,
          mockModelOutput: null,
          finalResponse: null,
          inputSummary: null,
          outputSummary: null,
        }).where(inArray(detectionSessions.id, sessionIds)).returning({ id: detectionSessions.id })
      : [];
    const purgedRecords = recordIds.length
      ? await transaction.update(detectionRecords).set({
          rawText: null,
          maskedText: null,
          rewrittenText: null,
          summary: null,
        }).where(inArray(detectionRecords.id, recordIds)).returning({ id: detectionRecords.id })
      : [];
    const purgedFindings = recordIds.length
      ? await transaction.update(riskFindings).set({ evidence: null, reason: null, suggestion: null })
        .where(inArray(riskFindings.recordId, recordIds)).returning({ id: riskFindings.id })
      : [];
    const purgedAgentTraces = await transaction.update(agentTraces).set({
      requestPayload: null,
      responsePayload: null,
      errorMessage: null,
    }).where(and(
      lte(agentTraces.createdAt, cutoff),
      or(
        isNotNull(agentTraces.requestPayload),
        isNotNull(agentTraces.responsePayload),
        isNotNull(agentTraces.errorMessage),
      ),
    )).returning({ id: agentTraces.id });
    const purgedJudgeInvocations = await transaction.update(judgeModelInvocations).set({
      rawResponse: null,
      judgeReason: null,
      parseError: null,
      errorMessage: null,
    }).where(and(
      lte(judgeModelInvocations.createdAt, cutoff),
      or(
        isNotNull(judgeModelInvocations.rawResponse),
        isNotNull(judgeModelInvocations.judgeReason),
        isNotNull(judgeModelInvocations.parseError),
        isNotNull(judgeModelInvocations.errorMessage),
      ),
    ))
      .returning({ id: judgeModelInvocations.id });

    const result = {
      documents: purgedDocuments.length,
      documentFindings: purgedDocumentFindings.length,
      sessions: purgedSessions.length,
      records: purgedRecords.length,
      findings: purgedFindings.length,
      agentTraces: purgedAgentTraces.length,
      judgeInvocations: purgedJudgeInvocations.length,
    };
    const deletedObjectCount = Object.values(result)
      .reduce((sum, count) => sum + count, 0);
    if (deletedObjectCount === 0) {
      return { ...result, deletionProofId: null };
    }
    const deletionProof = buildDeletionProof({
      cutoff,
      completedAt: now,
      manifest: [
        { objectType: 'DOCUMENT', count: result.documents, idDigest: lineageObjectIdDigest(purgedDocuments.map((item) => item.id)) },
        { objectType: 'DOCUMENT_FINDING', count: result.documentFindings, idDigest: lineageObjectIdDigest(purgedDocumentFindings.map((item) => item.id)) },
        { objectType: 'SESSION', count: result.sessions, idDigest: lineageObjectIdDigest(purgedSessions.map((item) => item.id)) },
        { objectType: 'DETECTION_RECORD', count: result.records, idDigest: lineageObjectIdDigest(purgedRecords.map((item) => item.id)) },
        { objectType: 'RISK_FINDING', count: result.findings, idDigest: lineageObjectIdDigest(purgedFindings.map((item) => item.id)) },
        { objectType: 'AGENT_TRACE', count: result.agentTraces, idDigest: lineageObjectIdDigest(purgedAgentTraces.map((item) => item.id)) },
        { objectType: 'JUDGE_INVOCATION', count: result.judgeInvocations, idDigest: lineageObjectIdDigest(purgedJudgeInvocations.map((item) => item.id)) },
      ],
      phases: {
        database: {
          state: 'COMPLETE',
          evidence: canonicalJson({
            rawContentCutoff: cutoff.toISOString(),
            expiredDocumentCutoff: now.toISOString(),
            deletedObjectCount,
          }),
        },
        objectStore: { state: 'NOT_APPLICABLE', evidence: 'No object-store key is handled by this worker' },
        searchIndex: { state: 'NOT_APPLICABLE', evidence: 'No search-index record is handled by this worker' },
        backup: { state: 'PENDING_EXTERNAL', evidence: 'Subject to deployment backup expiry policy' },
      },
    });
    await transaction.insert(dataDeletionProofs).values({
      proofId: deletionProof.proofId,
      version: deletionProof.version,
      cutoff: new Date(deletionProof.cutoff),
      manifest: [...deletionProof.manifest],
      phases: deletionProof.phases,
      completedAt: new Date(deletionProof.completedAt),
      keyId: deletionProof.keyId,
      signature: deletionProof.signature,
    });
    return { ...result, deletionProofId: deletionProof.proofId };
  });
}
