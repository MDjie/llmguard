import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { artifacts, artifactParts, artifactPurgeLedger, artifactDerivatives, generatedContentDerivatives, guardJobs, mediaEvidenceSnapshots, ragSources } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { S3ArtifactVersionStore, type ArtifactVersionStore } from './version-store';
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Artifact = typeof artifacts.$inferSelect;
const DRAIN_MS = 65000;
const LOCK_MS = 120000;
function jobSource(artifact: Artifact) {
  return and(scopePredicate(guardJobs, artifact), or(eq(guardJobs.artifactId, artifact.id), eq(guardJobs.contextArtifactId, artifact.id),
    sql`${guardJobs.executionBinding}->'artifacts' @> ${JSON.stringify([{ id: artifact.id }])}::jsonb`));
}
async function references(tx: Transaction, artifact: Artifact): Promise<boolean> {
  const [job] = await tx.select({ id: guardJobs.id }).from(guardJobs).where(and(jobSource(artifact), inArray(guardJobs.status, ['pending','running','retrying']))).limit(1);
  if (job) return true;
  const [snapshot] = await tx.select({ id: mediaEvidenceSnapshots.id }).from(mediaEvidenceSnapshots).innerJoin(guardJobs, and(eq(guardJobs.id, mediaEvidenceSnapshots.jobId), scopePredicate(guardJobs, artifact))).where(and(scopePredicate(mediaEvidenceSnapshots, artifact), jobSource(artifact), ne(mediaEvidenceSnapshots.state, 'DELETED'))).limit(1);
  if (snapshot) return true;
  const [rag] = await tx.select({ id: ragSources.id }).from(ragSources).where(and(scopePredicate(ragSources, artifact), eq(ragSources.artifactId, artifact.id), ne(ragSources.state, 'deleted'))).limit(1);
  if (rag) return true;
  const [derived] = await tx.select({ id: artifactDerivatives.id }).from(artifactDerivatives).innerJoin(artifacts, eq(artifacts.id, artifactDerivatives.artifactId)).where(and(scopePredicate(artifactDerivatives, artifact), eq(artifactDerivatives.parentArtifactId, artifact.id), isNull(artifacts.purgedAt))).limit(1);
  if (derived) return true;
  const [marked] = await tx.select({ id: generatedContentDerivatives.id }).from(generatedContentDerivatives).where(and(scopePredicate(generatedContentDerivatives, artifact), eq(generatedContentDerivatives.sourceArtifactId, artifact.id))).limit(1);
  return Boolean(marked);
}
/** Queue cancellation in the same transaction that fences further upload/completion. */
export async function requestArtifactPurge(scope: TenantScope, ownerId: string, id: string, now = new Date()) {
  return db.transaction(async tx => {
    const [artifact] = await tx.select().from(artifacts).where(and(scopePredicate(artifacts, scope), eq(artifacts.ownerId, ownerId), eq(artifacts.id, id))).for('update');
    if (!artifact) throw new Error('GRD_ARTIFACT_NOT_FOUND');
    if (artifact.purgedAt) return artifact;
    if (!['uploading','failed','quarantined','deleted'].includes(artifact.state) || artifact.holdUntil && artifact.holdUntil > now || await references(tx, artifact)) throw new Error('GRD_ARTIFACT_NOT_CANCELLABLE');
    await queue(tx, artifact, now); return { ...artifact, state: 'deleted' };
  });
}
async function queue(tx: Transaction, artifact: Artifact, now: Date, fence = true) {
  if (artifact.objectPrefix !== artifact.tenantId + '/' + artifact.applicationId + '/' + artifact.id) throw new Error('ARTIFACT_PURGE_PREFIX_INVALID');
  const expiry = artifact.uploadExpiresAt?.getTime() ?? now.getTime() + 3600000;
  if (fence) await tx.update(artifacts).set({ state: 'deleted' }).where(eq(artifacts.id, artifact.id));
  await tx.insert(artifactPurgeLedger).values({ tenantId: artifact.tenantId, applicationId: artifact.applicationId, artifactId: artifact.id, objectPrefix: artifact.objectPrefix,
    notBefore: new Date(Math.max(now.getTime(), expiry) + DRAIN_MS), retryAt: now }).onConflictDoNothing();
}
export async function holdArtifact(scope: TenantScope, id: string, until: Date) {
  if (!Number.isFinite(until.getTime()) || until <= new Date()) throw new Error('ARTIFACT_HOLD_INVALID');
  return db.transaction(async tx => {
    const [artifact] = await tx.select().from(artifacts).where(and(scopePredicate(artifacts, scope), eq(artifacts.id, id))).for('update');
    const [ledger] = await tx.select().from(artifactPurgeLedger).where(eq(artifactPurgeLedger.artifactId, id)).for('update');
    if (!artifact || artifact.purgedAt || ledger?.state === 'DELETING' || ledger?.state === 'PURGED') throw new Error('ARTIFACT_HOLD_UNAVAILABLE');
    if (artifact.holdUntil && artifact.holdUntil > until) throw new Error('ARTIFACT_HOLD_CANNOT_SHORTEN');
    await tx.update(artifacts).set({ holdUntil: until }).where(eq(artifacts.id, id));
  });
}
export async function enqueueExpiredArtifacts(now = new Date(), limit = 20) {
  const candidates = await db.select({ id: artifacts.id }).from(artifacts).where(and(isNull(artifacts.purgedAt), sql`not exists (select 1 from artifact_purge_ledger l where l.artifact_id = ${artifacts.id})`,
    inArray(artifacts.state, ['uploading','accepted','failed','quarantined','deleted']), or(eq(artifacts.state, 'deleted'), lte(artifacts.contentExpiresAt, now))))
    .orderBy(artifacts.contentExpiresAt).limit(limit);
  let count = 0;
  for (const candidate of candidates) await db.transaction(async tx => {
    const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, candidate.id)).for('update', { skipLocked: true });
    if (!artifact || artifact.purgedAt || !['uploading','accepted','failed','quarantined','deleted'].includes(artifact.state) || artifact.state !== 'deleted' && artifact.contentExpiresAt > now) return;
    await queue(tx, artifact, now, false); count++;
  });
  return count;
}
export async function purgeNextArtifact(store: ArtifactVersionStore = new S3ArtifactVersionStore(), now = new Date()) {
  const token = randomUUID();
  const candidates = await db.select({ id: artifactPurgeLedger.artifactId }).from(artifactPurgeLedger).where(and(ne(artifactPurgeLedger.state, 'PURGED'), lte(artifactPurgeLedger.notBefore, now), lte(artifactPurgeLedger.retryAt, now), or(isNull(artifactPurgeLedger.leaseUntil), lte(artifactPurgeLedger.leaseUntil, now)))).orderBy(artifactPurgeLedger.retryAt).limit(10);
  let claimed: { artifact: Artifact; ledger: typeof artifactPurgeLedger.$inferSelect } | null = null;
  for (const candidate of candidates) {
    claimed = await db.transaction(async tx => {
      const [artifact] = await tx.select().from(artifacts).where(eq(artifacts.id, candidate.id)).for('update', { skipLocked: true });
      if (!artifact || artifact.purgedAt || !['uploading','accepted','failed','quarantined','deleted'].includes(artifact.state) || artifact.state !== 'deleted' && artifact.contentExpiresAt > now) return null;
      const [ledger] = await tx.select().from(artifactPurgeLedger).where(and(eq(artifactPurgeLedger.artifactId, candidate.id), ne(artifactPurgeLedger.state, 'PURGED'), lte(artifactPurgeLedger.notBefore, now), lte(artifactPurgeLedger.retryAt, now), or(isNull(artifactPurgeLedger.leaseUntil), lte(artifactPurgeLedger.leaseUntil, now)))).for('update');
      if (!ledger) return null;
      if (artifact.holdUntil && artifact.holdUntil > now || await references(tx, artifact)) {
        await tx.update(artifactPurgeLedger).set({ retryAt: new Date(now.getTime() + 60000), errorCode: 'ARTIFACT_PURGE_REFERENCED_OR_HELD' }).where(eq(artifactPurgeLedger.artifactId, artifact.id)); return null;
      }
      if (ledger.objectPrefix !== artifact.objectPrefix || artifact.objectPrefix !== artifact.tenantId + '/' + artifact.applicationId + '/' + artifact.id) throw new Error('ARTIFACT_PURGE_PREFIX_INVALID');
      await tx.update(artifactPurgeLedger).set({ state: 'DELETING', leaseToken: token, leaseUntil: new Date(now.getTime() + LOCK_MS), attempt: ledger.attempt + 1 }).where(eq(artifactPurgeLedger.artifactId, artifact.id));
      await tx.update(artifacts).set({ state: 'deleted' }).where(eq(artifacts.id, artifact.id));
      return { artifact: { ...artifact, state: 'deleted' }, ledger };
    });
    if (claimed) break;
  }
  if (!claimed) return null;
  const { artifact } = claimed, signal = AbortSignal.timeout(90000);
  const ownership = and(eq(artifactPurgeLedger.artifactId, artifact.id), eq(artifactPurgeLedger.leaseToken, token), eq(artifactPurgeLedger.state, 'DELETING'));
  try {
    const versions = await store.list(artifact.objectPrefix, artifact.partCount, signal);
    const recordedVersions = [...new Map([...claimed.ledger.versions, ...versions].map(version => [JSON.stringify([version.key, version.versionId]), version])).values()];
    const updated = await db.update(artifactPurgeLedger).set({ versions: recordedVersions }).where(and(ownership, gt(artifactPurgeLedger.leaseUntil, new Date()))).returning({ id: artifactPurgeLedger.artifactId });
    if (!updated.length) throw new Error('ARTIFACT_PURGE_LEASE_LOST');
    for (const version of versions.slice(0, 100)) { signal.throwIfAborted(); await store.remove(version, signal); }
    const remaining = await store.list(artifact.objectPrefix, artifact.partCount, signal);
    return await db.transaction(async tx => {
      const [current] = await tx.select().from(artifacts).where(eq(artifacts.id, artifact.id)).for('update');
      const [ledger] = await tx.select().from(artifactPurgeLedger).where(and(ownership, gt(artifactPurgeLedger.leaseUntil, new Date()))).for('update');
      if (!current || !ledger || current.state !== 'deleted' || current.holdUntil && current.holdUntil > new Date()) throw new Error('ARTIFACT_PURGE_LEASE_LOST');
      if (remaining.length) {
        await tx.update(artifactPurgeLedger).set({ leaseToken: null, leaseUntil: null, retryAt: new Date(), errorCode: 'ARTIFACT_PURGE_VERSIONS_REMAIN' }).where(ownership);
        return { artifactId: artifact.id, status: 'pending', remainingVersions: remaining.length };
      }
      const purgedAt = new Date();
      await tx.update(artifactParts).set({ state: 'deleted' }).where(and(scopePredicate(artifactParts, artifact), eq(artifactParts.artifactId, artifact.id)));
      await tx.update(artifacts).set({ purgedAt }).where(eq(artifacts.id, artifact.id));
      await tx.update(artifactPurgeLedger).set({ state: 'PURGED', purgedAt, leaseToken: null, leaseUntil: null, errorCode: null }).where(ownership);
      return { artifactId: artifact.id, status: 'purged', verifiedEmpty: true };
    });
  } catch {
    await db.update(artifactPurgeLedger).set({ leaseToken: null, leaseUntil: null, retryAt: new Date(Date.now() + 60000), errorCode: 'ARTIFACT_PURGE_RETRY_REQUIRED' }).where(ownership);
    return { artifactId: artifact.id, status: 'retrying' };
  }
}
