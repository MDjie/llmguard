import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { artifacts, artifactDerivatives, guardJobs } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { readNormalizedAsset } from '@/lib/artifacts/normalized';
import { normalizedAssetSchema, normalizedText } from '@/lib/artifacts/normalized-contract';
import { storeVerifiedBytes } from '@/lib/artifacts/server-upload';
import { submitGuardJob } from '@/lib/guard-jobs';
import { mediaRagLineageSchema, validateMediaRagLineage } from './media-lineage';
export const mediaRagIngestSchema = z.object({ intakeJobId: z.uuid(), sourceUri: z.string().min(1).max(2000), idempotencyKey: z.string().regex(/^[a-zA-Z0-9._:-]{8,100}$/) }).strict();

export async function submitMediaRagIngest(scope: TenantScope, ownerId: string, input: z.infer<typeof mediaRagIngestSchema>, signal?: AbortSignal) {
  const [job] = await db.select().from(guardJobs).where(and(scopePredicate(guardJobs, scope), eq(guardJobs.ownerId, ownerId), eq(guardJobs.id, input.intakeJobId))).limit(1);
  if (!job) throw new Error('MEDIA_RAG_JOB_UNAVAILABLE');
  const sources = z.array(normalizedAssetSchema).min(1).max(8).safeParse(job.result?.normalizedAssets);
  if (!sources.success) throw new Error('MEDIA_RAG_SOURCE_INCOMPLETE');
  const lineage = mediaRagLineageSchema.parse({ version: 'media-rag-lineage-1', intakeJobId: job.id, jobDigest: sha256(canonicalJson(job.result)), bundleId: job.bundleId,
    ownerId, sources: sources.data });
  const verified = await validateMediaRagLineage(db, scope, ownerId, lineage);
  const documents = [];
  for (const ref of lineage.sources) documents.push(await readNormalizedAsset(scope, ownerId, ref, signal));
  const text = documents.map(document => normalizedText(document).text).join('\n');
  if (!text.trim()) throw new Error('MEDIA_RAG_TEXT_EMPTY');
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 32768);
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  if (chunks.length > 1000) throw new Error('MEDIA_RAG_CHUNK_BUDGET_EXCEEDED');
  const classification = Math.max(...verified.rows.map(row => typeof row.metadata?.classification === 'number' ? row.metadata.classification : 10));
  const expiresAt = new Date(Math.min(...verified.rows.map(row => row.contentExpiresAt.getTime())));
  const jobs: Array<{ jobId: string; artifactId: string; reused: boolean }> = [];
  for (const [index, content] of chunks.entries()) {
    signal?.throwIfAborted();
    const identity = sha256(canonicalJson([input.idempotencyKey, lineage, input.sourceUri, index, content]));
    const child = await storeVerifiedBytes({ scope, ownerId, kind: 'RAG_CHUNK', fileName: 'media-rag-' + index + '.txt', mediaType: 'text/plain', bytes: Buffer.from(content),
      idempotencyKey: 'media-rag-' + identity, metadata: { sourceUri: input.sourceUri, sourceType: 'NORMALIZED_MEDIA', sourceVersion: lineage.jobDigest, trustLevel: 0,
        classification, allowedPrincipals: [ownerId], allowedRoles: [], validUntilEpochMs: expiresAt.getTime(), mediaLineage: lineage }, signal });
    await db.transaction(async tx => {
      await validateMediaRagLineage(tx, scope, ownerId, lineage);
      if (child.contentExpiresAt > expiresAt) await tx.update(artifacts).set({ contentExpiresAt: expiresAt }).where(eq(artifacts.id, child.id));
      for (const source of lineage.sources) await tx.insert(artifactDerivatives).values({ ...scope, artifactId: child.id, parentArtifactId: source.parentArtifactId, viewId: 'rag-' + identity,
        transform: 'media-rag-1', parameters: { lineage, chunkIndex: index, chunkCount: chunks.length }, coordinateMapping: { version: 'normalized-segment-projection-1', sourceArtifactId: source.artifactId }, sha256: child.verifiedSha256! }).onConflictDoNothing();
    });
    const submitted = await submitGuardJob({ scope, ownerId, artifactId: child.id, bundleId: job.bundleId, jobType: 'rag_ingest', idempotencyKey: 'media-rag-job-' + identity, maxAttempts: 2 });
    jobs.push({ jobId: submitted.job.id, artifactId: child.id, reused: submitted.reused });
  }
  return { intakeJobId: job.id, sourceDigest: lineage.jobDigest, representation: 'TEXT_PROJECTION', nativeCoverageClaimed: false, allowedPrincipals: [ownerId], jobs };
}
