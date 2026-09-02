import { and, desc, eq, isNotNull, notExists } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import {
  auditEvidenceTimestamps,
  securityAuditEvents,
} from '@/storage/database/shared/schema';
import { requestTrustedTimestamp } from './trusted-timestamp';

export async function timestampPendingAuditEvents(batchSize = 20): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('Timestamp batch size must be between 1 and 100');
  }
  const candidates = await db.select({
    id: securityAuditEvents.id,
    tenantId: securityAuditEvents.tenantId,
    applicationId: securityAuditEvents.applicationId,
    partitionKey: securityAuditEvents.partitionKey,
    chainSequence: securityAuditEvents.chainSequence,
    eventHash: securityAuditEvents.eventHash,
  }).from(securityAuditEvents).where(and(
    isNotNull(securityAuditEvents.partitionKey),
    isNotNull(securityAuditEvents.chainSequence),
    isNotNull(securityAuditEvents.eventHash),
    notExists(
      db.select({ id: auditEvidenceTimestamps.id })
        .from(auditEvidenceTimestamps)
        .where(eq(auditEvidenceTimestamps.auditEventId, securityAuditEvents.id)),
    ),
  )).orderBy(desc(securityAuditEvents.createdAt)).limit(batchSize);

  let anchored = 0;
  for (const candidate of candidates) {
    const envelope = await requestTrustedTimestamp(candidate.eventHash!);
    await db.insert(auditEvidenceTimestamps).values({
      auditEventId: candidate.id,
      tenantId: candidate.tenantId,
      applicationId: candidate.applicationId,
      partitionKey: candidate.partitionKey!,
      chainSequence: candidate.chainSequence!,
      headHash: candidate.eventHash!,
      provider: envelope.provider,
      generatedAt: new Date(envelope.generatedAt),
      token: envelope.token,
      keyFingerprint: envelope.keyFingerprint,
      signature: envelope.signature,
      verificationStatus: 'VERIFIED',
      verifiedAt: new Date(),
    }).onConflictDoNothing();
    anchored += 1;
  }
  return anchored;
}
