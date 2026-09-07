import type { artifacts, ragChunks, ragSources } from '@/storage/database/shared/schema';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';

export interface RagReferenceRow {
  chunk: typeof ragChunks.$inferSelect;
  source: typeof ragSources.$inferSelect;
  artifact: typeof artifacts.$inferSelect;
}
/** Captures mutable authorization and object metadata without storing source text. */
export function ragReferenceBinding(row: RagReferenceRow): string {
  return canonicalJson({
    chunkId: row.chunk.id, sourceId: row.source.id, artifactId: row.artifact.id,
    chunkState: row.chunk.state, sourceState: row.source.state, artifactState: row.artifact.state,
    contentHash: row.chunk.contentHash, signature: row.chunk.provenanceSignature, metadata: row.chunk.metadata,
    acl: row.source.acl, classification: row.source.classification, trustLevel: row.source.trustLevel,
    verifiedHash: row.artifact.verifiedSha256, verifiedSize: row.artifact.verifiedSize, expiresAt: row.artifact.contentExpiresAt.getTime(),
  });
}
export function ragReferenceDigest(row: RagReferenceRow): string { return sha256(ragReferenceBinding(row)); }
