import { withWorkerHeartbeat } from '../src/lib/operations/worker-health';
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
async function main() {
  const [{ recoverArchiveObjects, reconcileArchiveRequests, verifyArchiveStoredObjects }, { deleteExpiredConversationArchive }, { closeDatabaseConnection, db }, s, { and, asc, inArray, lt }] = await Promise.all([
    import('../src/lib/conversation-archive/service'), import('../src/lib/conversation-archive/retention'), import('../src/storage/database/shared/db'), import('../src/storage/database/shared/schema'), import('drizzle-orm'),
  ]);
  let stopping = false; process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try { do {
    const {maintainMediaEvidence}=await import('../src/lib/evidence/media-snapshots');
    await maintainMediaEvidence(5).catch(()=>console.error('MEDIA_EVIDENCE_MAINTENANCE_PENDING'));
    await recoverArchiveObjects(3).catch(() => console.error('ARCHIVE_RECOVERY_PENDING'));
    await verifyArchiveStoredObjects(10).catch(() => console.error('ARCHIVE_VERSION_VERIFICATION_PENDING'));
    await reconcileArchiveRequests(20).catch(() => console.error('ARCHIVE_RECONCILIATION_PENDING'));
    const expired = await db.select().from(s.conversationArchives).where(and(inArray(s.conversationArchives.state, ['COMMITTED','DELETE_PENDING']), lt(s.conversationArchives.expiresAt, new Date()))).orderBy(asc(s.conversationArchives.expiresAt)).limit(10);
    for (const row of expired) { if (stopping) break; await deleteExpiredConversationArchive(row, row.requestId).catch(() => console.error('ARCHIVE_EXPIRY_CLEANUP_PENDING')); }
    if (process.argv.includes('--once')) break;
    for (let i = 0; i < 5 && !stopping; i++) await new Promise(resolve => setTimeout(resolve, 1000));
  } while (!stopping); } finally { await closeDatabaseConnection(); }
}
withWorkerHeartbeat('archive', main).catch(() => { console.error('ARCHIVE_WORKER_FAILED'); process.exitCode = 1; });
