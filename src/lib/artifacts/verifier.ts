import {pcmFromMetadata} from '@/lib/media/formats/pcm';
import {StreamingTextValidator,textEncodingFromMetadata} from '@/lib/media/formats/text-decoder';
import {formatForFile, normalizeMediaType} from '@/lib/media/formats/registry';
import {signatureMatchesFormat} from '@/lib/media/formats/signature';
import { createHash } from 'node:crypto';
import { and, asc, eq, or, lt } from 'drizzle-orm';
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

async function claimArtifact(target?: {id:string;ownerId:string;tenantId:string;applicationId:string}) {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction.select().from(artifacts)
      .where(and(or(eq(artifacts.state, 'verifying'),and(eq(artifacts.state,'verification_running'),lt(artifacts.completedAt,new Date(Date.now()-15*60_000)))),...(target?[eq(artifacts.id,target.id),eq(artifacts.ownerId,target.ownerId),scopePredicate(artifacts,target)]:[]))).orderBy(asc(artifacts.completedAt))
      .limit(1).for('update', { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await transaction.update(artifacts).set({ state: 'verification_running', completedAt:new Date() })
      .where(and(eq(artifacts.id, candidate.id), scopePredicate(artifacts, candidate))).returning();
    return claimed ?? null;
  });
}

function declaredKindMatches(kind: string, declaredMediaType: string, detectedMediaType: string): boolean {
  const family = declaredMediaType.split('/')[0];
  if (kind === 'AUDIO' && family === 'audio' && ['video/mp4', 'video/x-ms-wmv', 'video/webm', 'video/x-matroska', 'video/3gpp'].includes(detectedMediaType)) return true;
  if (kind === 'DOCUMENT' && detectedMediaType === 'application/zip') return true;
  return detectedMediaType === 'text/plain'
    ? ['TEXT', 'TOOL_RESULT', 'RAG_CHUNK'].includes(kind)
    : detectedMediaType.startsWith(`${family}/`) || detectedMediaType.startsWith('application/');
}

async function verifyClaimedArtifact(artifact: typeof artifacts.$inferSelect): Promise<boolean> {
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
  const validator=['TEXT','TOOL_RESULT','RAG_CHUNK'].includes(artifact.kind)?new StreamingTextValidator(textEncodingFromMetadata(artifact.metadata)):undefined;
  const timeout=AbortSignal.timeout(10*60_000);
  for (const part of parts) {
    const signed = await signer.presign('GET', part.objectKey, { expiresSeconds: 300 });
    const response = await fetch(signed.url, { headers: signed.headers, signal: AbortSignal.any([timeout,AbortSignal.timeout(60_000)]), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`Object part fetch failed with status ${response.status}`);
    const partHash = createHash('sha256');
    let partSize = 0;
    const reader = response.body.getReader();
    let finished=false;
    try { while (true) {
      const item = await reader.read();
      if (item.done) {finished=true;break;}
      const chunk = Buffer.from(item.value);
      try { validator?.push(chunk); } catch { throw new ArtifactIntegrityError('GRD_ARTIFACT_TEXT_ENCODING_INVALID','Text encoding or binary content invalid'); }
      partHash.update(chunk);
      totalHash.update(chunk);
      if (partSize + chunk.length > part.sizeBytes || verifiedSize + chunk.length > artifact.declaredSize) {
        await reader.cancel();
        throw new ArtifactIntegrityError('GRD_ARTIFACT_SIZE_MISMATCH', 'Object exceeded declared bounds');
      }
      partSize += chunk.length;
      verifiedSize += chunk.length;
      if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk]).subarray(0, 512);
    }
    } finally {if(!finished)await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    if (partSize !== part.sizeBytes || partHash.digest('hex') !== part.sha256) {
      throw new ArtifactIntegrityError('GRD_ARTIFACT_PART_HASH_MISMATCH', 'A stored part failed size or hash verification');
    }
    await db.update(artifactParts).set({ state: 'verified', verifiedAt: new Date() }).where(and(
      eq(artifactParts.id, part.id),
      scopePredicate(artifactParts, scope),
    ));
  }
  const aggregateHash = totalHash.digest('hex');
  try { validator?.finish(); } catch { throw new ArtifactIntegrityError('GRD_ARTIFACT_TEXT_ENCODING_INVALID','Text encoding or binary content invalid'); }
  const pcm = pcmFromMetadata(artifact.fileName, artifact.metadata, verifiedSize);
  const detected = pcm ? {mediaType:'audio/pcm',family:'audio' as const} : validator ? {mediaType:'text/plain',family:'text' as const} : detectMagic(prefix);
  if (verifiedSize !== artifact.declaredSize || aggregateHash !== artifact.declaredSha256) {
    throw new ArtifactIntegrityError('GRD_ARTIFACT_HASH_MISMATCH', 'Artifact size or SHA-256 differs from the declaration');
  }
  if (!magicMatchesKind(artifact.kind, detected) &&
      !(artifact.kind === 'AUDIO' && ['video/mp4', 'video/x-ms-wmv', 'video/webm', 'video/x-matroska', 'video/3gpp'].includes(detected.mediaType))) {
    throw new ArtifactIntegrityError('GRD_ARTIFACT_MAGIC_MISMATCH', 'Artifact magic bytes do not match its declared kind');
  }
  const format = formatForFile(artifact.fileName, artifact.declaredMediaType);
  const mime = normalizeMediaType(artifact.declaredMediaType);
  if (format && (!signatureMatchesFormat(format, detected) || (mime !== 'application/octet-stream' && !format.mimeTypes.includes(mime)))) {
    throw new ArtifactIntegrityError('GRD_ARTIFACT_FORMAT_MISMATCH', 'Declared format conflicts with verified bytes');
  }
  if (!format && !declaredKindMatches(artifact.kind, artifact.declaredMediaType, detected.mediaType)) {
    throw new ArtifactIntegrityError('GRD_ARTIFACT_MIME_MISMATCH', 'Declared MIME type conflicts with decoded magic bytes');
  }
  const accepted = await db.update(artifacts).set({
    state: 'accepted',
    verifiedSize,
    verifiedSha256: aggregateHash,
    detectedMediaType: detected.mediaType,
    verifiedAt: new Date(),
    failureCode: null,
  }).where(and(eq(artifacts.id, artifact.id), scopePredicate(artifacts, scope),eq(artifacts.state,'verification_running'),eq(artifacts.completedAt,artifact.completedAt!))).returning({id:artifacts.id});
  return accepted.length === 1;
}

export async function verifyNextArtifact(target?: {id:string;ownerId:string;tenantId:string;applicationId:string}): Promise<{ artifactId: string; state: string } | null> {
  const artifact = await claimArtifact(target);
  if (!artifact) return null;
  try {
    const accepted = await verifyClaimedArtifact(artifact);
    return { artifactId: artifact.id, state: accepted ? 'accepted' : 'superseded' };
  } catch (error) {
    const integrity = error instanceof ArtifactIntegrityError;
    const failed = await db.update(artifacts).set({
      state: integrity ? 'quarantined' : 'failed',
      failureCode: integrity ? error.code : 'GRD_ARTIFACT_VERIFICATION_FAILED',
    }).where(and(eq(artifacts.id, artifact.id), scopePredicate(artifacts, artifact),eq(artifacts.state,'verification_running'),eq(artifacts.completedAt,artifact.completedAt!))).returning({id:artifacts.id});
    return { artifactId: artifact.id, state: failed.length ? (integrity ? 'quarantined' : 'failed') : 'superseded' };
  }
}
