import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, closeDatabaseConnection } from '@/storage/database/shared/db';
import { artifacts, guardJobs } from '@/storage/database/shared/schema';
import { scopePredicate } from '@/lib/tenancy';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { submitGuardJob } from '@/lib/guard-jobs';
import { parseMediaManifest, mediaManifestDigest, summarizeMediaManifest, type MediaCaseOutcome } from '@/lib/evaluation/media-manifest';
const [manifestPath, identityPath, resultPath] = process.argv.slice(2);
if (!manifestPath || !identityPath || !resultPath) throw new Error('Usage: pnpm detection:media-manifest manifest.csv identity.private.json result.json');
const manifest = parseMediaManifest(manifestPath, readFileSync(manifestPath, 'utf8'));
const identity = z.object({ tenantId: z.uuid(), applicationId: z.uuid(), ownerId: z.string().min(1), bundleId: z.string().min(1) }).strict().parse(JSON.parse(readFileSync(identityPath, 'utf8')));
const results: Array<MediaCaseOutcome & { jobId: string; reasonCodes: unknown; sources: unknown }> = [];
const output = resolve(resultPath);
if (existsSync(output) || !existsSync(dirname(output))) throw new Error('NEW_RESULT_PATH_REQUIRED');
async function main() {
  // All source references are validated before the first job is submitted.
  for (const item of manifest.cases) {
    const rows = await db.select().from(artifacts).where(and(scopePredicate(artifacts, identity), eq(artifacts.ownerId, identity.ownerId), inArray(artifacts.id, item.artifacts.map(ref => ref.artifactId))));
    if (rows.length !== item.artifacts.length || item.artifacts.some(ref => {
      const row = rows.find(row => row.id === ref.artifactId);
      return !row || row.state !== 'accepted' || row.contentExpiresAt <= new Date() || row.verifiedSha256 !== ref.sha256 || row.kind !== ref.kind;
    })) throw new Error('MEDIA_MANIFEST_SOURCE_UNAVAILABLE');
  }
  for (const item of manifest.cases) {
    const submitted = await submitGuardJob({ scope: identity, ownerId: identity.ownerId, artifactId: item.artifacts[0].artifactId, sourceArtifactIds: item.artifacts.map(ref => ref.artifactId), expectedIntakeSources: item.artifacts,
      taskPurpose: item.inputText, bundleId: identity.bundleId, jobType: 'intake', idempotencyKey: 'manifest-' + sha256(canonicalJson([identity, mediaManifestDigest(manifest), item.caseId])), maxAttempts: 2 });
    const deadline = Date.now() + 1800000; let terminal: typeof guardJobs.$inferSelect | undefined;
    while (Date.now() < deadline) {
      const [row] = await db.select().from(guardJobs).where(and(scopePredicate(guardJobs, identity), eq(guardJobs.id, submitted.job.id)));
      if (row && ['completed','failed','cancelled'].includes(row.status)) { terminal = row; break; }
      console.log(JSON.stringify({ caseId: item.caseId, stage: row?.stage ?? 'unavailable' })); await new Promise(resolve => setTimeout(resolve, 5000));
    }
    const value = terminal?.result ?? {}, native = z.object({ eligible: z.boolean() }).loose().safeParse(value.nativeCoverage);
    const qualified = item.artifacts.every(ref => ref.kind === 'TEXT') ? false : native.success && native.data.eligible;
    const status = terminal?.status !== 'completed' ? 'FAILED' : value.operationalOutcome === 'COMPLETE' ? 'COMPLETE' : 'BLOCKED';
    results.push({ caseId: item.caseId, jobId: submitted.job.id, status, action: typeof value.action === 'string' ? value.action : 'UNKNOWN', qualified,
      reasonCodes: value.degradationReasons ?? [], sources: item.artifacts });
    writeFileSync(output, JSON.stringify({ ...summarizeMediaManifest(manifest, results), results }, null, 2));
  }
  const summary = summarizeMediaManifest(manifest, results);
  process.exitCode = results.some(result => result.status === 'FAILED') ? 1 : summary.excluded.length ? 2 : 0;
}
main().catch(() => { writeFileSync(output, JSON.stringify({ status: 'FAIL', code: 'MEDIA_MANIFEST_EXECUTION_FAILED', results }, null, 2)); process.exitCode = 1; }).finally(closeDatabaseConnection);
