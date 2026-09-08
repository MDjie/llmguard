/** Real isolated PostgreSQL + S3 + signed development policy; synthetic text, no model quality claim. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../src/storage/database/shared/db';
import { artifacts, artifactParts, guardJobs, ragSources, ragChunks, dataLineageEdges, users } from '../../../src/storage/database/shared/schema';
import { scopePredicate } from '../../../src/lib/tenancy';
import { objectStoreConfig, S3Presigner } from '../../../src/lib/object-store';
import { submitGuardJob, cancelGuardJob } from '../../../src/lib/guard-jobs';
import { processNextRagIngestJob } from '../../../src/lib/rag/ingest-worker';

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('ISOLATED_FIXTURE_REQUIRED');
  for (const key of ['DATABASE_URL', 'PGDATABASE_URL', 'COZE_SUPABASE_DB_URL']) {
    const url = new URL(process.env[key] ?? '');
    if (url.hostname !== '127.0.0.1' || url.port !== '5438' || url.pathname !== '/guardtest') throw new Error('ISOLATED_DATABASE_REQUIRED');
  }
  const config = objectStoreConfig();
  if (config.endpoint.origin !== 'http://127.0.0.1:59000') throw new Error('ISOLATED_OBJECT_STORE_REQUIRED');
  const fixture = z.object({
    scope: z.literal('ISOLATED_CLONE_ENGINEERING_ONLY'), tenantId: z.string(), applicationId: z.string(),
    userId: z.string(), other: z.object({ username: z.string() }),
  }).parse(JSON.parse(readFileSync(out + '/fixture.private.json', 'utf8')));
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId };
  const [pending] = await db.select({ id: guardJobs.id }).from(guardJobs).where(and(
    eq(guardJobs.jobType, 'rag_ingest'), inArray(guardJobs.status, ['pending', 'running', 'retrying']),
  )).limit(1);
  if (pending) throw new Error('ISOLATED_RAG_QUEUE_MUST_BE_IDLE');
  const [prior] = await db.select().from(guardJobs).where(scopePredicate(guardJobs, scope)).orderBy(desc(guardJobs.createdAt)).limit(1);
  const [other] = await db.select().from(users).where(eq(users.username, fixture.other.username)).limit(1);
  if (!prior || !other || other.id === fixture.userId) throw new Error('FIXTURE_MISSING');
  // This ephemeral signing identity is used only for synthetic fixture records in the isolated database.
  process.env.RAG_PROVENANCE_KEY = randomBytes(48).toString('base64url');
  const signer = new S3Presigner(config);
  const results: Array<{ case: string; pass: boolean }> = [];
  const ensure = (condition: boolean, code: string) => { if (!condition) throw new Error(code); };
  async function create(ownerId: string, externalChunkId: string = randomUUID()) {
    const id = randomUUID(), bytes = Buffer.from('Synthetic knowledge: the blue folder contains three public documents.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const objectKey = scope.tenantId + '/' + scope.applicationId + '/' + id + '/part-1';
    const put = await signer.presign('PUT', objectKey, { ifNoneMatch: true, expiresSeconds: 60 });
    const response = await fetch(put.url, { method: 'PUT', headers: put.headers, body: bytes, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('ISOLATED_OBJECT_WRITE_FAILED');
    const [artifact] = await db.insert(artifacts).values({
      ...scope, id, ownerId, kind: 'RAG_CHUNK', fileName: 'synthetic-worker.txt', declaredMediaType: 'text/plain',
      declaredSize: bytes.length, verifiedSize: bytes.length, declaredSha256: sha256, verifiedSha256: sha256,
      objectPrefix: scope.tenantId + '/' + scope.applicationId + '/' + id, state: 'accepted',
      idempotencyKey: id, requestHash: sha256, partSize: 16 * 1024 * 1024, partCount: 1,
      metadata: { sourceUri: 'synthetic:' + id, sourceType: 'synthetic', externalChunkId, allowedPrincipals: [ownerId] },
      contentExpiresAt: new Date(Date.now() + 3600000),
    }).returning();
    await db.insert(artifactParts).values({ ...scope, artifactId: id, partNumber: 1, sizeBytes: bytes.length, sha256, objectKey, state: 'verified', verifiedAt: new Date() });
    const submission = await submitGuardJob({ scope, ownerId, artifactId: id, bundleId: prior.bundleId, jobType: 'rag_ingest', idempotencyKey: randomUUID(), maxAttempts: 1 });
    return { artifact, job: submission.job, objectKey };
  }
  async function state(id: string) {
    const [job] = await db.select().from(guardJobs).where(eq(guardJobs.id, id));
    return job;
  }
  async function sourceCount(artifactId: string) {
    return (await db.select({ id: ragSources.id }).from(ragSources).where(and(scopePredicate(ragSources, scope), eq(ragSources.artifactId, artifactId)))).length;
  }
  async function run(jobId: string) {
    const result = await processNextRagIngestJob();
    ensure(result?.jobId === jobId, 'UNEXPECTED_JOB_CLAIMED');
    return state(jobId);
  }
  const success = await create(fixture.userId);
  const completed = await run(success.job.id);
  const [source] = await db.select().from(ragSources).where(eq(ragSources.artifactId, success.artifact.id));
  const [chunk] = await db.select().from(ragChunks).where(eq(ragChunks.artifactId, success.artifact.id));
  const lineage = source ? await db.select().from(dataLineageEdges).where(and(scopePredicate(dataLineageEdges, scope), eq(dataLineageEdges.sourceId, source.id))) : [];
  ensure(completed.status === 'completed' && source?.state === 'accepted' && chunk?.state === 'accepted' && lineage.length === 1 && chunk.metadata?.ingestJobId === success.job.id, 'RAG_WORKER_ATOMIC_SUCCESS_FAILED');
  results.push({ case: 'actual-object-read-policy-and-atomic-rag-lineage-commit', pass: true });

  const duplicate = await create(other.id, chunk.externalChunkId);
  const conflict = await run(duplicate.job.id);
  const [preserved] = await db.select().from(ragChunks).where(eq(ragChunks.id, chunk.id));
  ensure(conflict.status === 'failed' && await sourceCount(duplicate.artifact.id) === 0 && preserved.artifactId === success.artifact.id, 'RAG_OWNER_CONFLICT_NOT_FENCED');
  results.push({ case: 'different-owner-cannot-replace-existing-chunk', pass: true });

  const tampered = await create(fixture.userId);
  await db.update(artifacts).set({ metadata: { ...tampered.artifact.metadata, allowedRoles: ['admin'] } }).where(eq(artifacts.id, tampered.artifact.id));
  ensure((await run(tampered.job.id)).status === 'failed' && await sourceCount(tampered.artifact.id) === 0, 'RAG_SOURCE_CHANGED_AFTER_SUBMISSION_ACCEPTED');
  results.push({ case: 'submission-source-metadata-binding-rejects-change', pass: true });

  for (const action of ['change-metadata', 'cancel'] as const) {
    const fixtureCase = await create(fixture.userId);
    const originalFetch = globalThis.fetch;
    let intercepted = false;
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (!intercepted && url.origin === config.endpoint.origin && decodeURIComponent(url.pathname).endsWith('/' + fixtureCase.objectKey)) {
        intercepted = true;
        if (action === 'cancel') await cancelGuardJob(scope, fixture.userId, fixtureCase.job.id);
        else await db.update(artifacts).set({ metadata: { ...fixtureCase.artifact.metadata, allowedRoles: ['admin'] } }).where(eq(artifacts.id, fixtureCase.artifact.id));
      }
      return response;
    };
    let terminal: typeof guardJobs.$inferSelect;
    try { terminal = await run(fixtureCase.job.id); } finally { globalThis.fetch = originalFetch; }
    ensure(intercepted && terminal.status === (action === 'cancel' ? 'cancelled' : 'failed') && await sourceCount(fixtureCase.artifact.id) === 0, 'RAG_CHANGE_DURING_READ_NOT_FENCED');
    results.push({ case: action + '-during-object-read-has-no-domain-side-effects', pass: true });
  }
  writeFileSync(out + '/rag-worker-smoke.json', JSON.stringify({ scope: 'ISOLATED_REAL_RAG_WORKER_SYNTHETIC_TEXT_EMPTY_DEVELOPMENT_POLICY', semanticQualification: false, results }, null, 2));
  console.log(JSON.stringify(results));
}
main().then(() => process.exit(0)).catch(error => {
  console.error(error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'RAG_WORKER_SMOKE_FAILED');
  process.exit(1);
});
