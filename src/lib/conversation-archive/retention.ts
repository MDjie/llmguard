import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { archivedContentObjects, conversationArchives, gatewayRequests, contentAccessRequests, dataDeletionProofs } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { buildDeletionProof, lineageObjectIdDigest } from '@/lib/data-protection/lineage';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import { archiveObjectStore, type ArchiveObjectStore } from './object-store';
/** Expiry cleanup is separate from short-lived gateway content cleanup and always names immutable object versions. */
export async function deleteExpiredConversationArchive(scope: TenantScope, requestId: string, store?: ArchiveObjectStore, now = new Date()) {
  const prepared = await db.transaction(async transaction => {
    const [request] = await transaction.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, requestId))).for('update');
    const [archive] = await transaction.select().from(conversationArchives).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, requestId))).for('update');
    if (!request || !archive || archive.state === 'DELETED') return null;
    if (!['COMMITTED','DELETE_PENDING'].includes(archive.state) || archive.expiresAt >= now || (archive.holdUntil && archive.holdUntil >= now) || (request.contentHoldUntil && request.contentHoldUntil >= now) || !request.sessionFinalized) return null;
    const objects = await transaction.select().from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.requestId, requestId)));
    if (!objects.length || objects.some(object => !['MANIFEST_COMMITTED','INDEXED','DELETE_PENDING','DELETED'].includes(object.state) || !object.objectVersion)) return null;
    const [grant] = await transaction.select({ id: contentAccessRequests.id }).from(contentAccessRequests).where(and(scopePredicate(contentAccessRequests, scope), eq(contentAccessRequests.resourceType, 'ARCHIVED_CONTENT'),
      inArray(contentAccessRequests.resourceId, objects.map(object => object.id)), eq(contentAccessRequests.status, 'approved'), isNull(contentAccessRequests.usedAt), gt(contentAccessRequests.expiresAt, now))).limit(1);
    if (grant) return null;
    // Verify signing configuration before a destructive object operation can start.
    buildDeletionProof({ cutoff: now, completedAt: now, manifest: [{ objectType: 'ARCHIVED_CONTENT', count: objects.length, idDigest: lineageObjectIdDigest(objects.map(object => object.id)) }], phases: { database: { state: 'COMPLETE' } } });
    if (archive.state === 'COMMITTED') {
      await transaction.update(conversationArchives).set({ state: 'DELETE_PENDING', version: archive.version + 1 }).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, requestId)));
      await transaction.update(archivedContentObjects).set({ state: 'DELETE_PENDING' }).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.requestId, requestId), inArray(archivedContentObjects.state, ['MANIFEST_COMMITTED','INDEXED'])));
    }
    return objects;
  });
  if (!prepared) return null;
  const objectStore = store ?? archiveObjectStore();
  for (const object of prepared) {
    if (object.state === 'DELETED') continue;
    await objectStore.deleteVersion(object.objectKey, object.objectVersion!);
    await db.update(archivedContentObjects).set({ state: 'DELETED', deletedAt: now }).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.id, object.id), eq(archivedContentObjects.state, 'DELETE_PENDING')));
  }
  return db.transaction(async transaction => {
    await transaction.select({ id: gatewayRequests.id }).from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, requestId))).for('update');
    const [archive] = await transaction.select().from(conversationArchives).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, requestId))).for('update');
    if (!archive) throw new Error('ARCHIVE_DELETE_MANIFEST_MISSING');
    if (archive.state === 'DELETED') return { deletionProofId: archive.deletionProofId, backupStatus: 'PENDING_EXTERNAL' as const };
    const objects = await transaction.select().from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects, scope), eq(archivedContentObjects.requestId, requestId)));
    if (archive.state !== 'DELETE_PENDING' || objects.some(object => object.state !== 'DELETED')) throw new Error('ARCHIVE_DELETE_INCOMPLETE');
    const proof = buildDeletionProof({ cutoff: now, completedAt: now, manifest: [{ objectType: 'ARCHIVED_CONTENT', count: objects.length, idDigest: lineageObjectIdDigest(objects.map(object => object.id)) }],
      phases: { database: { state: 'COMPLETE', evidence: 'Encrypted spool removed; scoped metadata tombstones retained.' }, objectStore: { state: 'COMPLETE', evidence: 'Every recorded immutable object version received a successful deletion response.' }, searchIndex: { state: 'COMPLETE', evidence: 'Archive state hides expired content from queries.' }, backup: { state: 'PENDING_EXTERNAL', evidence: 'Backup copies require deployment lifecycle confirmation.' } } });
    await transaction.insert(dataDeletionProofs).values({ proofId: proof.proofId, version: proof.version, cutoff: new Date(proof.cutoff), manifest: [...proof.manifest], phases: proof.phases,
      completedAt: new Date(proof.completedAt), keyId: proof.keyId, signature: proof.signature });
    await transaction.update(conversationArchives).set({ state: 'DELETED', deletionProofId: proof.proofId, version: archive.version + 1 }).where(and(scopePredicate(conversationArchives, scope), eq(conversationArchives.requestId, requestId)));
    await appendAuditEventInTransaction(transaction, { ...scope, event: 'archive.content.deleted', outcome: 'ALLOWED', status: 200, requestId: proof.proofId, traceId: requestId, method: 'INTERNAL', path: '/api/conversations/retention', latencyMs: 0 });
    return { deletionProofId: proof.proofId, backupStatus: 'PENDING_EXTERNAL' as const };
  });
}
