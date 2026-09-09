import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { artifacts, guardJobs } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { normalizedAssetSchema } from '@/lib/artifacts/normalized-contract';
type Reader = Pick<Parameters<Parameters<typeof db.transaction>[0]>[0], 'select'>;
export const mediaRagLineageSchema = z.object({
  version: z.literal('media-rag-lineage-1'), intakeJobId: z.uuid(), jobDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bundleId: z.string().min(1), ownerId: z.string().min(1), sources: z.array(normalizedAssetSchema).min(1).max(8),
}).strict();
export async function validateMediaRagLineage(reader: Reader, scope: TenantScope, ownerId: string, raw: unknown) {
  const lineage = mediaRagLineageSchema.parse(raw);
  if (lineage.ownerId !== ownerId) throw new Error('MEDIA_RAG_OWNER_CHANGED');
  const [job] = await reader.select().from(guardJobs).where(and(scopePredicate(guardJobs, scope), eq(guardJobs.ownerId, ownerId), eq(guardJobs.id, lineage.intakeJobId))).for('share');
  if (!job || job.jobType !== 'intake' || job.status !== 'completed' || job.bundleId !== lineage.bundleId || sha256(canonicalJson(job.result)) !== lineage.jobDigest) throw new Error('MEDIA_RAG_JOB_CHANGED');
  const parsed = z.object({ operationalOutcome: z.literal('COMPLETE'), degraded: z.literal(false), action: z.enum(['ALLOW','WARN']),
    releaseEligibility: z.object({ eligible: z.literal(true) }).loose(), normalizedAssets: z.array(normalizedAssetSchema).min(1).max(8),
    nativeCoverage: z.object({ eligible: z.boolean() }).loose().nullable().optional(),
  }).loose().safeParse(job.result);
  if (!parsed.success || parsed.data.normalizedAssets.some(ref => !ref.complete) || canonicalJson(parsed.data.normalizedAssets) !== canonicalJson(lineage.sources)) throw new Error('MEDIA_RAG_SOURCE_INCOMPLETE');
  const ids = [...new Set(lineage.sources.flatMap(ref => [ref.artifactId, ref.parentArtifactId]))].sort();
  const rows = await reader.select().from(artifacts).where(and(scopePredicate(artifacts, scope), eq(artifacts.ownerId, ownerId), inArray(artifacts.id, ids))).orderBy(artifacts.id).for('share');
  if (rows.length !== ids.length || rows.some(row => row.state !== 'accepted' || row.contentExpiresAt <= new Date())) throw new Error('MEDIA_RAG_SOURCE_UNAVAILABLE');
  for (const ref of lineage.sources) {
    const parent = rows.find(row => row.id === ref.parentArtifactId)!, child = rows.find(row => row.id === ref.artifactId)!;
    if (parent.verifiedSha256 !== ref.parentSha256 || child.verifiedSha256 !== ref.sha256) throw new Error('MEDIA_RAG_SOURCE_DIGEST_CHANGED');
    if (parent.kind !== 'TEXT' && parsed.data.nativeCoverage?.eligible !== true) throw new Error('MEDIA_RAG_NATIVE_QUALIFICATION_REQUIRED');
  }
  return { lineage, rows, job };
}
