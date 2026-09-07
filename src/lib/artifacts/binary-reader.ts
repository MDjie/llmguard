import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifactParts, artifacts } from '@/storage/database/shared/schema';

export type BinaryArtifactKind = 'IMAGE' | 'AUDIO' | 'VIDEO';

export async function readAcceptedArtifactBytes(
  scope: TenantScope,
  artifactId: string,
  maximumBytes = 1_048_576,
  acceptedKinds: readonly BinaryArtifactKind[] = ['IMAGE','AUDIO','VIDEO'],
  parentSignal?: AbortSignal,
): Promise<Uint8Array> {
  const [artifact] = await db.select().from(artifacts).where(and(
    eq(artifacts.id, artifactId), eq(artifacts.state, 'accepted'), scopePredicate(artifacts, scope),
  )).limit(1);
  if (!artifact || !acceptedKinds.some(kind => kind === artifact.kind) ||
      artifact.verifiedSize === null || artifact.verifiedSize > maximumBytes ||
      !artifact.verifiedSha256 || artifact.contentExpiresAt <= new Date()) {
    throw new Error('Accepted binary context is unavailable, expired or exceeds the fusion limit');
  }
  const parts = await db.select().from(artifactParts).where(and(
    eq(artifactParts.artifactId, artifactId), scopePredicate(artifactParts, scope),
  )).orderBy(asc(artifactParts.partNumber));
  if (!parts.length || parts.length !== artifact.partCount ||
      parts.some((part,index)=>part.partNumber!==index+1||part.state!=='verified') ||
      parts.reduce((sum,part)=>sum+part.sizeBytes,0)!==artifact.verifiedSize) {
    throw new Error('Binary context manifest is incomplete');
  }
  const signer = new S3Presigner(objectStoreConfig());
  const contentHash = createHash('sha256');
  const timeout = AbortSignal.timeout(30000);
  const signal = parentSignal ? AbortSignal.any([parentSignal,timeout]) : timeout;
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (const part of parts) {
    signal.throwIfAborted();
    const signed = await signer.presign('GET', part.objectKey, { expiresSeconds: 60 });
    const response = await fetch(signed.url, { headers: signed.headers, signal, redirect:'error', cache:'no-store' });
    if (!response.ok || !response.body) throw new Error('Binary context object read failed');
    const reader = response.body.getReader(), partHash=createHash('sha256');
    let partBytes=0,finished=false;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) { finished=true;break; }
        bytes+=item.value.byteLength;partBytes+=item.value.byteLength;
        if (bytes>maximumBytes || partBytes>part.sizeBytes) throw new Error('Binary context exceeded its declared limit');
        contentHash.update(item.value);partHash.update(item.value);
        chunks.push(item.value);
      }
    } finally { if (!finished) await reader.cancel().catch(()=>undefined);reader.releaseLock(); }
    if (partBytes!==part.sizeBytes || partHash.digest('hex')!==part.sha256) throw new Error('Binary context part integrity changed');
  }
  if (bytes!==artifact.verifiedSize || contentHash.digest('hex')!==artifact.verifiedSha256) throw new Error('Binary context integrity changed');
  return Buffer.concat(chunks);
}
