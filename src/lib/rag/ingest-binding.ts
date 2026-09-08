import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import type { artifacts } from '@/storage/database/shared/schema';
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const ragIngestBindingSchema = z.object({ version: z.literal('rag-ingest-1'), artifactId: z.uuid(), sha256, sizeBytes: z.number().int().positive(), metadataSha256: sha256 }).strict();
export function captureRagIngestBinding(artifact: Pick<typeof artifacts.$inferSelect, 'id' | 'kind' | 'state' | 'verifiedSha256' | 'verifiedSize' | 'metadata' | 'contentExpiresAt'>) {
    if (artifact.kind !== 'RAG_CHUNK' || artifact.state !== 'accepted' || artifact.contentExpiresAt <= new Date())
        throw new Error('RAG_SOURCE_UNAVAILABLE');
    return ragIngestBindingSchema.parse({ version: 'rag-ingest-1', artifactId: artifact.id, sha256: artifact.verifiedSha256, sizeBytes: artifact.verifiedSize, metadataSha256: createHash('sha256').update(canonicalJson(artifact.metadata ?? {})).digest('hex') });
}
export function assertRagIngestBinding(raw: unknown, artifact: Parameters<typeof captureRagIngestBinding>[0]): void {
    const expected = ragIngestBindingSchema.safeParse(raw);
    if (!expected.success)
        throw new Error('RAG_SOURCE_BINDING_REQUIRED');
    if (canonicalJson(expected.data) !== canonicalJson(captureRagIngestBinding(artifact)))
        throw new Error('RAG_SOURCE_BINDING_CHANGED');
}
