import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
import { scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifactParts, artifacts } from '@/storage/database/shared/schema';
import { detectMagic, magicMatchesKind } from './magic';

class ArtifactIntegrityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}

async function claimArtifact() {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction.select().from(artifacts)
      .where(eq(artifacts.state, 'verifying')).orderBy(asc(artifacts.completedAt))
      .limit(1).for('update', { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await transaction.update(artifacts).set({ state: 'verification_running' })
      .where(and(eq(artifacts.id, candidate.id), scopePredicate(artifacts, candidate))).returning();
    return claimed ?? null;
  });
}

function declaredKindMatches(kind: string, declaredMediaType: string, detectedMediaType: string): boolean {
  const family = declaredMediaType.split('/')[0];
  if (kind === 'AUDIO' && family === 'audio' && ['video/mp4', 'video/x-ms-wmv'].includes(detectedMediaType)) return true;
  if (kind === 'DOCUMENT' && detectedMediaType === 'application/zip') return true;
  return detectedMediaType === 'text/plain'
    ? ['TEXT', 'TOOL_RESULT', 'RAG_CHUNK'].includes(kind)
    : detectedMediaType.startsWith(`${family}/`) || detectedMediaType.startsWith('application/');
}

async function verifyClaimedArtifact(artifact: typeof artifacts.$inferSelect): Promise<void> {
  const scope = { tenantId: artifact.tenantId, applicationId: artifact.applicationId };
  const parts = await db.select().from(artifactParts).where(and(
    eq(artifactParts.artifactId, artifact.id),
    scopePredicate(artifactParts, scope),
  )).orderBy(asc(artifactParts.partNumber));
  if (parts.length !== artifact.partCount) {
    throw new ArtifactIntegrityError('GRD_ARTIFACT_PARTS_MISSING', 'Stored part count differs from the manifest');
  }
  const signer = new S3Presigner(objectStoreConfig());
  const totalHash = createHash('sha256');
  let verifiedSize = 0;
  let prefix = Buffer.alloc(0);
  for (const part of parts) {
    const signed = await signer.presign('GET', part.objectKey, { expiresSeconds: 300 });
    const response = await fetch(signed.url, { headers: signed.headers, signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error(`Object part fetch failed with status ${response.status}`);
    const partHash = createHash('sha256');
    let partSize = 0;
    const reader = response.body.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      partHash.update(chunk);
      totalHash.update(chunk);
      partSize += chunk.length;
      verifiedSize += chunk.length;
      if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk]).subarray(0, 512);
    }
    if (partSize !== part.sizeBytes || partHash.digest('hex') !== part.sha256) {
      throw new ArtifactIntegrityError('GRD_ARTIFACT_PART_HASH_MISMATCH', 'A stored part failed size or hash verification');
    }
    await db.update(artifactParts).set({ state: 'verified', verifiedAt: new Date() }).where(and(
      eq(artifactParts.id, part.id),
      scopePredicate(artifactParts, scope),
    ));
  }
  const aggregateHash = totalHash.digest('hex');
  const detected = detectMagic(prefix);
  if (verifiedSize !== artifact.declaredSize || aggregateHash !== artifact.declaredSha256) {
    throw new ArtifactIntegrityError('GRD_ARTIFACT_HASH_MISMATCH', 'Artifact size or SHA-256 differs from the declaration');
  }
  if (!magicMatchesKind(artifact.kind, detected) &&
      !(artifact.kind === 'AUDIO' && ['video/mp4', 'video/x-ms-wmv'].includes(detected.mediaType))) {
    throw new ArtifactIntegrityError('GRD_ARTIFACT_MAGIC_MISMATCH', 'Artifact magic bytes do not match its declared kind');
  }
  if (!declaredKindMatches(artifact.kind, artifact.declaredMediaType, detected.mediaType)) {
    throw new ArtifactIntegrityError('GRD_ARTIFACT_MIME_MISMATCH', 'Declared MIME type conflicts with decoded magic bytes');
  }
  await db.update(artifacts).set({
    state: 'accepted',
    verifiedSize,
    verifiedSha256: aggregateHash,
    detectedMediaType: detected.mediaType,
    verifiedAt: new Date(),
    failureCode: null,
  }).where(and(eq(artifacts.id, artifact.id), scopePredicate(artifacts, scope)));
}

export async function verifyNextArtifact(): Promise<{ artifactId: string; state: string } | null> {
  const artifact = await claimArtifact();
  if (!artifact) return null;
  try {
    await verifyClaimedArtifact(artifact);
    return { artifactId: artifact.id, state: 'accepted' };
  } catch (error) {
    const integrity = error instanceof ArtifactIntegrityError;
    await db.update(artifacts).set({
      state: integrity ? 'quarantined' : 'failed',
      failureCode: integrity ? error.code : 'GRD_ARTIFACT_VERIFICATION_FAILED',
    }).where(and(eq(artifacts.id, artifact.id), scopePredicate(artifacts, artifact)));
    return { artifactId: artifact.id, state: integrity ? 'quarantined' : 'failed' };
  }
}
