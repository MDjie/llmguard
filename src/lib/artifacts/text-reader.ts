import { and, asc, eq } from 'drizzle-orm';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifactParts, artifacts } from '@/storage/database/shared/schema';

export type TextArtifactKind = 'TEXT' | 'RAG_CHUNK' | 'TOOL_RESULT';

export async function readAcceptedTextArtifact(
  scope: TenantScope,
  artifactId: string,
  maximumBytes = 1_048_576,
  acceptedKinds: readonly TextArtifactKind[] = ['TEXT'],
): Promise<string> {
  const [artifact] = await db.select().from(artifacts).where(and(
    eq(artifacts.id, artifactId),
    eq(artifacts.state, 'accepted'), scopePredicate(artifacts, scope),
  )).limit(1);
  if (
    !artifact
    || !acceptedKinds.includes(artifact.kind as TextArtifactKind)
    || artifact.verifiedSize === null
    || artifact.verifiedSize > maximumBytes
  ) {
    throw new Error('Accepted text context is missing or exceeds the fusion limit');
  }
  const parts = await db.select().from(artifactParts).where(and(
    eq(artifactParts.artifactId, artifactId), scopePredicate(artifactParts, scope),
  )).orderBy(asc(artifactParts.partNumber));
  const signer = new S3Presigner(objectStoreConfig());
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  let bytes = 0;
  for (const part of parts) {
    const signed = await signer.presign('GET', part.objectKey, { expiresSeconds: 300 });
    const response = await fetch(signed.url, { headers: signed.headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error('Text context object read failed');
    const reader = response.body.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error('Text context exceeded the bounded reader limit');
      }
      result += decoder.decode(item.value, { stream: true });
    }
  }
  return result + decoder.decode();
}
