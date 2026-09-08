import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../src/storage/database/shared/db';
import { artifacts, guardJobs, guardJobEvents, ragSources } from '../../../src/storage/database/shared/schema';
import { scopePredicate } from '../../../src/lib/tenancy';
import { completeGuardJobWithEffects, cancelGuardJob, isGuardJobCancellationError } from '../../../src/lib/guard-jobs';
async function main() {
    const out = process.argv[2];
    if (!out)
        throw new Error('ISOLATED_FIXTURE_REQUIRED');
    for (const key of ['DATABASE_URL', 'PGDATABASE_URL', 'COZE_SUPABASE_DB_URL']) {
        const url = new URL(process.env[key] ?? '');
        if (url.hostname !== '127.0.0.1' || url.port !== '5438' || url.pathname !== '/guardtest')
            throw new Error('ISOLATED_DATABASE_REQUIRED');
    }
    const fixture = z.object({ scope: z.literal('ISOLATED_CLONE_ENGINEERING_ONLY'), tenantId: z.string().min(1).max(36), applicationId: z.string().min(1).max(36), userId: z.string().min(1).max(100) }).parse(JSON.parse(readFileSync(out + '/fixture.private.json', 'utf8')));
    const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId };
    const [prior] = await db.select().from(guardJobs).where(scopePredicate(guardJobs, scope)).orderBy(desc(guardJobs.createdAt)).limit(1);
    if (!prior)
        throw new Error('FIXTURE_POLICY_JOB_REQUIRED');
    const results: Array<{
        case: string;
        pass: boolean;
    }> = [];
    const ensure = (condition: boolean, code: string) => { if (!condition)
        throw new Error(code); };
    async function createCase() {
        const id = randomUUID(), hash = 'a'.repeat(64);
        const [artifact] = await db.insert(artifacts).values({ ...scope, id, ownerId: fixture.userId, kind: 'RAG_CHUNK', fileName: 'synthetic-atomic.txt', declaredMediaType: 'text/plain', declaredSize: 1, verifiedSize: 1, declaredSha256: hash, verifiedSha256: hash, objectPrefix: scope.tenantId + '/' + scope.applicationId + '/' + id, state: 'accepted', idempotencyKey: id, requestHash: hash, partSize: 16 * 1024 * 1024, partCount: 1, metadata: { synthetic: true }, contentExpiresAt: new Date(Date.now() + 3600000) }).returning();
        const [job] = await db.insert(guardJobs).values({ ...scope, ownerId: fixture.userId, artifactId: artifact.id, bundleId: prior.bundleId, jobType: 'rag_ingest', status: 'running', stage: 'test', attempt: 1, maxAttempts: 2, heartbeatAt: new Date(), idempotencyKey: randomUUID(), requestHash: hash }).returning();
        return job;
    }
    const insertSource = async (transaction: Parameters<Parameters<typeof completeGuardJobWithEffects>[1]>[0], job: typeof guardJobs.$inferSelect) => { await transaction.insert(ragSources).values({ ...scope, artifactId: job.artifactId, sourceUriHash: 'b'.repeat(64), sourceType: 'synthetic_atomic_test', state: 'accepted' }); };
    const sourceCount = async (job: typeof guardJobs.$inferSelect) => (await db.select({ id: ragSources.id }).from(ragSources).where(and(scopePredicate(ragSources, scope), eq(ragSources.artifactId, job.artifactId)))).length;
    for (const kind of ['cancelled', 'stale-attempt']) {
        const job = await createCase();
        await db.update(guardJobs).set(kind === 'cancelled' ? { status: 'cancelled' } : { attempt: 2 }).where(eq(guardJobs.id, job.id));
        let called = false, rejected = false;
        try {
            await completeGuardJobWithEffects(job, async (tx) => { called = true; await insertSource(tx, job); return { result: { synthetic: true } }; });
        }
        catch (error) {
            rejected = isGuardJobCancellationError(error);
        }
        ensure(rejected && !called && await sourceCount(job) === 0, 'FENCE_FAILED');
        results.push({ case: kind + '-has-no-side-effects', pass: true });
        if (kind === 'stale-attempt')
            await cancelGuardJob(scope, fixture.userId, job.id);
    }
    const rollback = await createCase();
    let rolledBack = false;
    try {
        await completeGuardJobWithEffects(rollback, async (tx) => { await insertSource(tx, rollback); throw new Error('INJECTED_FAILURE'); });
    }
    catch (error) {
        rolledBack = error instanceof Error && error.message === 'INJECTED_FAILURE';
    }
    const [unchanged] = await db.select().from(guardJobs).where(eq(guardJobs.id, rollback.id));
    ensure(rolledBack && await sourceCount(rollback) === 0 && unchanged.status === 'running', 'ROLLBACK_FAILED');
    results.push({ case: 'domain-and-job-rollback-together', pass: true });
    await cancelGuardJob(scope, fixture.userId, rollback.id);
    const success = await createCase();
    await completeGuardJobWithEffects(success, async (tx) => { await insertSource(tx, success); return { result: { synthetic: true } }; });
    const [completed] = await db.select().from(guardJobs).where(eq(guardJobs.id, success.id));
    const events = await db.select().from(guardJobEvents).where(and(eq(guardJobEvents.jobId, success.id), eq(guardJobEvents.eventType, 'job.completed')));
    ensure(completed.status === 'completed' && await sourceCount(success) === 1 && events.length === 1, 'ATOMIC_COMMIT_FAILED');
    results.push({ case: 'domain-job-event-commit-together', pass: true });
    let duplicate = false;
    try {
        await completeGuardJobWithEffects(success, async (tx) => { await insertSource(tx, success); return { result: { synthetic: true } }; });
    }
    catch (error) {
        duplicate = isGuardJobCancellationError(error);
    }
    ensure(duplicate && await sourceCount(success) === 1, 'DUPLICATE_COMMIT_FAILED');
    results.push({ case: 'duplicate-completion-cannot-reapply-effects', pass: true });
    writeFileSync(out + '/rag-atomic-smoke.json', JSON.stringify({ scope: 'ISOLATED_POSTGRES_ATOMICITY_ONLY', results }, null, 2));
    console.log(JSON.stringify(results));
}
main().then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? JSON.stringify({ name: error.name, message: error.message.split('\n')[0].slice(0, 300), cause: error.cause instanceof Error ? error.cause.message.split('\n')[0].slice(0, 300) : undefined }) : 'ATOMIC_TEST_FAILED'); process.exit(1); });
