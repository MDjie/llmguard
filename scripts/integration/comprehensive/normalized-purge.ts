import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@/storage/database/shared/db';
import { artifacts, artifactPurgeLedger, guardJobs } from '@/storage/database/shared/schema';
import { createArtifactUpload, signArtifactPart } from '@/lib/artifacts/service';
import { storeVerifiedBytes } from '@/lib/artifacts/server-upload';
import { persistNormalizedAsset, readNormalizedAsset } from '@/lib/artifacts/normalized';
import { projectText } from '@/lib/artifacts/normalized-projection';
import { normalizedText } from '@/lib/artifacts/normalized-contract';
import { submitGuardJob, claimNextGuardJob } from '@/lib/guard-jobs';
import { requestArtifactPurge, purgeNextArtifact, holdArtifact } from '@/lib/artifacts/purge';
import { S3ArtifactVersionStore } from '@/lib/artifacts/version-store';
import { createHash } from 'node:crypto';
const out = resolve(process.env.COMPREHENSIVE_RUN_DIR!);
const fixture = JSON.parse(readFileSync(out + '/fixture.private.json', 'utf8')) as { tenantId: string; applicationId: string; userId: string; bundleId: string; other: { userId: string } };
const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId }, ownerId = fixture.userId;
const checks: { id: string; status: string }[] = [];
const check = (id: string) => { checks.push({ id, status: 'PASS' }); console.log(id + ' PASS'); };
async function main() {
  const url = new URL(process.env.DATABASE_URL!); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5438'); assert.match(url.pathname, /^\/guardllm_integration_full_\d+$/);
  const text = '归档原件'.repeat(350000) + '结束';
  const parent = await storeVerifiedBytes({ scope, ownerId, kind: 'TEXT', fileName: 'large-normalized.txt', mediaType: 'text/plain', bytes: Buffer.from(text) });
  const submitted = await submitGuardJob({ scope, ownerId, artifactId: parent.id, sourceArtifactIds: [parent.id], bundleId: fixture.bundleId, jobType: 'intake', idempotencyKey: randomUUID(), maxAttempts: 2 });
  const job = await claimNextGuardJob(['intake']); assert.equal(job?.id, submitted.job.id); assert.ok(job);
  const document = projectText({ parentArtifactId: parent.id, parentSha256: parent.verifiedSha256!, sourceKind: 'TEXT' }, text, 'utf-8');
  const ref = await persistNormalizedAsset(job, document);
  const restored = await readNormalizedAsset(scope, ownerId, ref);
  assert.equal(normalizedText(restored).text, text); check('NORMALIZED_REAL_OBJECT_AND_PARENT_DIGEST');
  assert.deepEqual(await persistNormalizedAsset(job, document), ref); check('NORMALIZED_IDEMPOTENT_RETRY');
  await assert.rejects(readNormalizedAsset(scope, fixture.other.userId, ref)); check('NORMALIZED_OWNER_ISOLATION');
  await assert.rejects(readNormalizedAsset(scope, ownerId, { ...ref, sha256: '0'.repeat(64) })); check('NORMALIZED_DIGEST_TAMPER_REJECTED');
  await db.update(guardJobs).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(guardJobs.id, job.id));
  await assert.rejects(persistNormalizedAsset(job, document), /SUPERSEDED/); check('NORMALIZED_CANCELLED_ATTEMPT_FENCED');

  const bytes = Buffer.from('synthetic orphaned upload'), digest = createHash('sha256').update(bytes).digest('hex');
  const { artifact } = await createArtifactUpload({ scope, ownerId, kind: 'TEXT', fileName: 'orphan.txt', mediaType: 'text/plain', sizeBytes: bytes.length, sha256: digest, idempotencyKey: randomUUID(), retentionDays: 1, metadata: {} });
  const signed = await signArtifactPart(scope, ownerId, artifact.id, 1);
  const put = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes, signal: AbortSignal.timeout(10000) }); assert.equal(put.status, 200); await put.body?.cancel();
  const store = new S3ArtifactVersionStore(); const originalVersions = await store.list(artifact.objectPrefix, 1); assert.equal(originalVersions.length, 1);
  await requestArtifactPurge(scope, ownerId, artifact.id); await requestArtifactPurge(scope, ownerId, artifact.id); check('PURGE_INTERRUPTED_UPLOAD_QUEUED_IDEMPOTENTLY');
  await assert.rejects(signArtifactPart(scope, ownerId, artifact.id, 1)); check('PURGE_NEW_UPLOAD_SIGNATURE_REJECTED');
  const [ledger] = await db.select().from(artifactPurgeLedger).where(eq(artifactPurgeLedger.artifactId, artifact.id));
  assert.ok(ledger.notBefore.getTime() >= Date.now() + 100000);
  assert.equal(await purgeNextArtifact(store), null); check('PURGE_WAIT_FOR_SIGNED_UPLOAD_EXPIRY');
  await holdArtifact(scope, artifact.id, new Date(Date.now() + 3600000));
  const future = new Date(ledger.notBefore.getTime() + 1000);
  assert.equal(await purgeNextArtifact(store, future), null); check('PURGE_HOLD_WINS_BEFORE_CLAIM');
  // Only this isolated synthetic artifact advances its hold/clock; do not sleep or alter production records.
  await db.update(artifacts).set({ holdUntil: new Date(0) }).where(eq(artifacts.id, artifact.id));
  await db.update(artifactPurgeLedger).set({ retryAt: new Date(0) }).where(eq(artifactPurgeLedger.artifactId, artifact.id));
  const failureStore = { list: store.list.bind(store), remove: async () => { throw new Error('injected object-store outage'); } };
  assert.equal((await purgeNextArtifact(failureStore, future))?.status, 'retrying');
  const [failed] = await db.select().from(artifacts).where(eq(artifacts.id, artifact.id)); assert.equal(failed.purgedAt, null); check('PURGE_FAILED_DELETE_RETAINS_QUOTA');
  let holdRefused = false, rewritten = false;
  const observingStore = { list: store.list.bind(store), remove: async (version: Parameters<typeof store.remove>[0], signal?: AbortSignal) => {
    await assert.rejects(holdArtifact(scope, artifact.id, new Date(Date.now() + 3600000)), /UNAVAILABLE/); holdRefused = true;
    await store.remove(version, signal);
    if (!rewritten) {
      // Simulates a write racing physical removal; the controlled clock is not a real TTL wait.
      const late = await fetch(signed.url, {method:'PUT',headers:signed.headers,body:bytes,signal:AbortSignal.timeout(10000)});
      assert.equal(late.status,200);await late.body?.cancel();rewritten=true;
    }
    return undefined;
  } };
  const raced = await purgeNextArtifact(observingStore, new Date(future.getTime() + 61000)); assert.equal(raced?.status, 'pending');
  const [retained] = await db.select().from(artifacts).where(eq(artifacts.id,artifact.id));assert.equal(retained.purgedAt,null);check('PURGE_VERSION_REWRITE_RETAINS_QUOTA');
  const result = await purgeNextArtifact(store, new Date(future.getTime() + 62000)); assert.equal(result?.status, 'purged'); assert.equal(holdRefused, true);
  assert.equal((await store.list(artifact.objectPrefix, 1)).length, 0); check('PURGE_EXACT_VERSIONS_AND_HOLD_RACE');
  const [purged] = await db.select().from(artifacts).where(eq(artifacts.id, artifact.id)); assert.ok(purged.purgedAt);
  const [usage] = await db.select({ count: sql<number>`count(*)::int` }).from(artifacts).where(and(eq(artifacts.id, artifact.id), sql`${artifacts.purgedAt} is null`)); assert.equal(usage.count, 0);
  assert.equal(await purgeNextArtifact(store, new Date(future.getTime() + 120000)), null); check('PURGE_QUOTA_RELEASED_AFTER_EMPTY_VERSION_CHECK');
  writeFileSync(out + '/normalized-purge-final.json', JSON.stringify({ status: 'PASS', scope: 'ISOLATED_REAL_POSTGRES_AND_VERSIONED_MINIO', purgeClock: 'CONTROLLED_SYNTHETIC_TTL_BOUNDARY', checks }, null, 2));
}
main().catch(error => { writeFileSync(out + '/normalized-purge-final.json', JSON.stringify({ status: 'FAIL', checks, error: error instanceof Error ? error.message.slice(0,300) : 'FAILED' }, null, 2)); console.error(error instanceof Error ? error.message.slice(0,300) : 'FAILED'); process.exitCode = 1; }).finally(closeDatabaseConnection);
