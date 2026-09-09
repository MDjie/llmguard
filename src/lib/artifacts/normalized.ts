import { intakeBindingSchema } from '@/lib/guard-jobs/intake-binding';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { artifacts, artifactDerivatives, guardJobs } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { storeVerifiedBytes } from './server-upload';
import { readAcceptedArtifactBytes } from './binary-reader';
import { encodeNormalizedDocument, NORMALIZED_MAX_BYTES, NORMALIZED_VERSION, normalizedAssetSchema, type NormalizedAsset } from './normalized-contract';

type Job = typeof guardJobs.$inferSelect;
export async function persistNormalizedAsset(job: Job, raw: unknown, signal?: AbortSignal): Promise<NormalizedAsset> {
  const { document, bytes, sha256 } = encodeNormalizedDocument(raw);
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  try {
    signal?.throwIfAborted();
    const child = await storeVerifiedBytes({ scope, ownerId: job.ownerId, kind: 'TEXT', fileName: 'normalized-source.json', mediaType: 'application/json', bytes,
      idempotencyKey: 'normalized-' + sha256, metadata: { representation: 'TEXT_PROJECTION', parentArtifactId: document.parentArtifactId, parentSha256: document.parentSha256, transformVersion: document.transformVersion }, signal });
    const asset = normalizedAssetSchema.parse({ version: NORMALIZED_VERSION, artifactId: child.id, sha256, parentArtifactId: document.parentArtifactId,
      parentSha256: document.parentSha256, transformVersion: document.transformVersion, representation: 'TEXT_PROJECTION', state: 'READY', complete: document.complete, nativeCoverageClaimed: false });
    await db.transaction(async tx => {
      const [currentJob] = await tx.select().from(guardJobs).where(and(scopePredicate(guardJobs, scope), eq(guardJobs.id, job.id))).for('share');
      if (!currentJob || currentJob.status !== 'running' || currentJob.attempt !== job.attempt || currentJob.cancelledAt) throw new Error('NORMALIZED_JOB_SUPERSEDED');
      const binding = intakeBindingSchema.parse(currentJob.executionBinding);
      if (currentJob.ownerId !== job.ownerId || currentJob.jobType !== 'intake' || !binding.artifacts.some(ref => ref.id === document.parentArtifactId && ref.sha256 === document.parentSha256 && ref.kind === document.sourceKind)) throw new Error('NORMALIZED_PARENT_NOT_BOUND');
      const rows = await tx.select().from(artifacts).where(and(scopePredicate(artifacts, scope), inArray(artifacts.id, [document.parentArtifactId, child.id]), eq(artifacts.ownerId, job.ownerId))).orderBy(artifacts.id).for('update');
      const parent = rows.find(row => row.id === document.parentArtifactId), currentChild = rows.find(row => row.id === child.id);
      if (!currentChild || currentChild.state !== 'accepted' || currentChild.contentExpiresAt <= new Date() || currentChild.verifiedSha256 !== sha256) throw new Error('NORMALIZED_CHILD_CHANGED');
      if (!parent || parent.state !== 'accepted' || parent.verifiedSha256 !== document.parentSha256 || parent.contentExpiresAt <= new Date()) throw new Error('NORMALIZED_PARENT_CHANGED');
      signal?.throwIfAborted();
      await tx.insert(artifactDerivatives).values({ ...scope, artifactId: child.id, parentArtifactId: parent.id, viewId: 'normalized-' + sha256,
        transform: NORMALIZED_VERSION, parameters: { ...asset, jobId: job.id, attempt: job.attempt }, coordinateMapping: { version: NORMALIZED_VERSION, artifactId: child.id, contentPath: '/segments' }, sha256 }).onConflictDoNothing();
      // A projection can never outlive its original source.
      if (child.contentExpiresAt > parent.contentExpiresAt) await tx.update(artifacts).set({ contentExpiresAt: parent.contentExpiresAt }).where(eq(artifacts.id, child.id));
    });
    return asset;
  } finally { bytes.fill(0); }
}

export async function readNormalizedAsset(scope: TenantScope, ownerId: string, raw: unknown, signal?: AbortSignal) {
  const ref = normalizedAssetSchema.parse(raw);
  const [derivative] = await db.select().from(artifactDerivatives).where(and(scopePredicate(artifactDerivatives, scope), eq(artifactDerivatives.artifactId, ref.artifactId),
    eq(artifactDerivatives.parentArtifactId, ref.parentArtifactId), eq(artifactDerivatives.sha256, ref.sha256), eq(artifactDerivatives.transform, NORMALIZED_VERSION))).limit(1);
  const rows = await db.select().from(artifacts).where(and(scopePredicate(artifacts, scope), eq(artifacts.ownerId, ownerId), inArray(artifacts.id, [ref.parentArtifactId, ref.artifactId])));
  const parent = rows.find(row => row.id === ref.parentArtifactId), child = rows.find(row => row.id === ref.artifactId);
  if (!derivative || !parent || !child || [parent, child].some(row => row.state !== 'accepted' || row.contentExpiresAt <= new Date()) || parent.verifiedSha256 !== ref.parentSha256 || child.verifiedSha256 !== ref.sha256) throw new Error('NORMALIZED_SOURCE_UNAVAILABLE');
  const bytes = await readAcceptedArtifactBytes(scope, child.id, NORMALIZED_MAX_BYTES, ['TEXT'], signal);
  try {
    const checked = encodeNormalizedDocument(JSON.parse(Buffer.from(bytes).toString('utf8')));
    try {
      if (checked.sha256 !== ref.sha256 || checked.document.parentArtifactId !== ref.parentArtifactId || checked.document.parentSha256 !== ref.parentSha256 || checked.document.transformVersion !== ref.transformVersion || checked.document.complete !== ref.complete) throw new Error('NORMALIZED_SOURCE_CHANGED');
      return checked.document;
    } finally { checked.bytes.fill(0); }
  } finally { bytes.fill(0); }
}
