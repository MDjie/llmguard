import {pcmFromMetadata} from '@/lib/media/formats/pcm';
import {textEncodingFromMetadata} from '@/lib/media/formats/text-decoder';
import {validateMediaFileMetadata, MEDIA_LIMITS} from '@/lib/media/formats/registry';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { canonicalJson } from '@/lib/policy-bundle';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifactParts, artifacts } from '@/storage/database/shared/schema';

const PART_SIZE = 16 * 1_024 * 1_024;
const TENANT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const LIMITS: Readonly<Record<string, number>> = {
  TEXT: MEDIA_LIMITS.text,
  IMAGE: MEDIA_LIMITS.image,
  AUDIO: MEDIA_LIMITS.audio,
  VIDEO: MEDIA_LIMITS.video,
  DOCUMENT: MEDIA_LIMITS.document,
  TOOL_RESULT: 100 * 1024 * 1024,
  RAG_CHUNK: 100 * 1024 * 1024,
};

export class ArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function artifactPartKey(prefix: string, partNumber: number): string {
  return `${prefix}/parts/${String(partNumber).padStart(5, '0')}`;
}

export async function createArtifactUpload(input: {
  scope: TenantScope;
  ownerId: string;
  kind: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  idempotencyKey: string;
  retentionDays: number;
  metadata: Record<string, unknown>;
}) {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > (LIMITS[input.kind] ?? 0)) {
    throw new ArtifactError('GRD_ARTIFACT_TOO_LARGE', 'Artifact exceeds the configured kind limit');
  }
  if (!['TOOL_RESULT','RAG_CHUNK'].includes(input.kind)) {
    try {
      const selected = validateMediaFileMetadata({name: input.fileName, type: input.mediaType, size: input.sizeBytes});
      if (selected.category.toUpperCase() !== input.kind) throw new Error('FILE_KIND_MISMATCH');
      pcmFromMetadata(input.fileName, input.metadata, input.sizeBytes);
      if (selected.category === 'text') textEncodingFromMetadata(input.metadata);
    } catch (error) { throw new ArtifactError('GRD_ARTIFACT_FORMAT_INVALID', error instanceof Error ? error.message : 'Invalid media metadata'); }
  }
  const requestHash = hash({
    ownerId: input.ownerId,
    retentionDays: input.retentionDays,
    kind: input.kind,
    fileName: input.fileName,
    mediaType: input.mediaType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    metadata: input.metadata,
  });
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.scope.tenantId}:artifacts`}))`);
    const [existing] = await transaction.select().from(artifacts).where(and(
      scopePredicate(artifacts, input.scope),
      eq(artifacts.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.requestHash !== requestHash) {
        throw new ArtifactError('GRD_IDEMPOTENCY_CONFLICT', 'Idempotency key was used for another artifact');
      }
      return { artifact: existing, reused: true };
    }
    const [usage] = await transaction.select({
      bytes: sql<string>`coalesce(sum(${artifacts.declaredSize}), 0)`,
    }).from(artifacts).where(and(
      eq(artifacts.tenantId, input.scope.tenantId),
      isNull(artifacts.purgedAt),
    ));
    if (Number(usage?.bytes ?? 0) + input.sizeBytes > TENANT_QUOTA_BYTES) {
      throw new ArtifactError('GRD_TENANT_ARTIFACT_QUOTA_EXCEEDED', 'Tenant artifact quota exceeded');
    }
    const id = randomUUID();
    const partCount = Math.ceil(input.sizeBytes / PART_SIZE);
    const [created] = await transaction.insert(artifacts).values({
      ...input.scope,
      id,
      ownerId: input.ownerId,
      kind: input.kind,
      fileName: input.fileName,
      declaredMediaType: input.mediaType.toLowerCase(),
      declaredSize: input.sizeBytes,
      declaredSha256: input.sha256,
      objectPrefix: `${input.scope.tenantId}/${input.scope.applicationId}/${id}`,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      partSize: PART_SIZE,
      partCount,
      metadata: input.metadata,
      contentExpiresAt: new Date(Date.now() + input.retentionDays * 86_400_000),
    }).returning();
    return { artifact: created, reused: false };
  });
}

export async function signArtifactPart(
  scope: TenantScope,
  ownerId: string,
  artifactId: string,
  partNumber: number,
  checksumSha256?: string,
) {
  return db.transaction(async transaction => {
  const [artifact] = await transaction.select().from(artifacts).where(and(
    eq(artifacts.id, artifactId),
    eq(artifacts.ownerId, ownerId),
    eq(artifacts.state, 'uploading'),
    scopePredicate(artifacts, scope),
  )).limit(1).for('update');
  if (!artifact || artifact.contentExpiresAt <= new Date()) throw new ArtifactError('GRD_ARTIFACT_NOT_UPLOADABLE', 'Artifact upload is unavailable');
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > artifact.partCount) throw new ArtifactError('GRD_ARTIFACT_PART_INVALID', 'Part number exceeds manifest');
  const signer = new S3Presigner(objectStoreConfig());
  const now = new Date();
  await transaction.update(artifacts).set({ uploadExpiresAt: new Date(now.getTime() + 60000) }).where(eq(artifacts.id, artifactId));
  return signer.presign('PUT', artifactPartKey(artifact.objectPrefix, partNumber), { expiresSeconds: 60, now, ifNoneMatch: true, checksumSha256 });
  });
}

export async function completeArtifactUpload(
  scope: TenantScope,
  ownerId: string,
  artifactId: string,
  parts: readonly { partNumber: number; sizeBytes: number; sha256: string; etag?: string }[],
) {
  return db.transaction(async (transaction) => {
    const [artifact] = await transaction.select().from(artifacts).where(and(
      eq(artifacts.id, artifactId),
      eq(artifacts.ownerId, ownerId),
      scopePredicate(artifacts, scope),
    )).limit(1).for('update');
    if (!artifact) throw new ArtifactError('GRD_ARTIFACT_NOT_FOUND', 'Artifact was not found');
    if (artifact.state === 'verifying' || artifact.state === 'verification_running' || artifact.state === 'accepted') return artifact;
    if (artifact.state !== 'uploading') throw new ArtifactError('GRD_ARTIFACT_STATE_INVALID', 'Artifact cannot be completed');
    const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
    if (sorted.length !== artifact.partCount || sorted.some((part, index) => part.partNumber !== index + 1)) {
      throw new ArtifactError('GRD_ARTIFACT_MANIFEST_INVALID', 'Part manifest is incomplete or duplicated');
    }
    const total = sorted.reduce((sum, part) => sum + part.sizeBytes, 0);
    if (total !== artifact.declaredSize || sorted.some((part, index) =>
      index < sorted.length - 1 && part.sizeBytes !== artifact.partSize || part.sizeBytes > artifact.partSize)) {
      throw new ArtifactError('GRD_ARTIFACT_SIZE_MISMATCH', 'Part sizes do not match the declared artifact');
    }
    await transaction.insert(artifactParts).values(sorted.map((part) => ({
      ...scope,
      artifactId,
      partNumber: part.partNumber,
      sizeBytes: part.sizeBytes,
      sha256: part.sha256,
      etag: part.etag,
      objectKey: artifactPartKey(artifact.objectPrefix, part.partNumber),
    })));
    const [updated] = await transaction.update(artifacts).set({
      state: 'verifying',
      completedAt: new Date(),
    }).where(and(eq(artifacts.id, artifactId), scopePredicate(artifacts, scope))).returning();
    return updated;
  });
}
