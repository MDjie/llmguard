import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { mediaEvidenceChunks } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { sealReceipt, openReceipt } from '@/lib/gateway-runtime/security';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import type { ArchiveObjectStore } from '@/lib/conversation-archive/object-store';
import type { SecretEnvelope } from '@/lib/secrets/types';
import { evidenceSnapshotSchema } from '@/contracts/http/media-evidence';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const MAX_MEDIA_EVIDENCE_BYTES = 64 * 1024 * 1024;
const PART_BYTES = 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const chunkReference = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), ordinal: z.number().int().nonnegative(), plaintextSha256: z.string().regex(/^[a-f0-9]{64}$/), plaintextBytes: z.number().int().positive().max(PART_BYTES) }).strict();
export const layeredManifestSchema = z.object({ version: z.literal('layered-media-evidence-1'), jobId: z.uuid(), totalBytes: z.number().int().positive().max(MAX_MEDIA_EVIDENCE_BYTES), plaintextSha256: z.string().regex(/^[a-f0-9]{64}$/), parts: z.array(chunkReference).min(1).max(64) }).strict();

export function splitEvidenceBytes(text: string): Uint8Array[] {
  const bytes = Buffer.from(text, 'utf8'); if (bytes.length > MAX_MEDIA_EVIDENCE_BYTES) throw new Error('MEDIA_EVIDENCE_TOTAL_BUDGET_EXCEEDED');
  const parts: Uint8Array[] = []; for (let offset = 0; offset < bytes.length; offset += PART_BYTES) parts.push(bytes.subarray(offset, offset + PART_BYTES));
  return parts;
}
export async function enqueueLayeredEvidence(tx: Transaction, scope: TenantScope, snapshotId: string, payload: z.infer<typeof evidenceSnapshotSchema>) {
  const text = canonicalJson(payload); const parts = splitEvidenceBytes(text); const references: z.infer<typeof chunkReference>[] = [];
  for (const [ordinal, bytes] of parts.entries()) {
    const plaintextSha256 = hash(bytes), id = hash(`${snapshotId}:${ordinal}:${plaintextSha256}`);
    const spool = sealReceipt({ version: 'media-evidence-chunk-1', snapshotId, ordinal, data: Buffer.from(bytes).toString('base64') }, 'media-evidence-chunk:' + id);
    const encoded = canonicalJson(spool);
    await tx.insert(mediaEvidenceChunks).values({ ...scope, id, snapshotId, ordinal, plaintextSha256, plaintextBytes: bytes.length, ciphertextSha256: hash(encoded), sizeBytes: Buffer.byteLength(encoded), objectKey: `archives/${scope.tenantId}/${scope.applicationId}/${id}.json`, spool });
    references.push({ id, ordinal, plaintextSha256, plaintextBytes: bytes.length });
  }
  return layeredManifestSchema.parse({ version: 'layered-media-evidence-1', jobId: payload.jobId, totalBytes: Buffer.byteLength(text), plaintextSha256: hash(text), parts: references });
}
export async function publishEvidenceChunks(scope: TenantScope, snapshotId: string, store: ArchiveObjectStore) {
  const chunks = await db.select().from(mediaEvidenceChunks).where(and(scopePredicate(mediaEvidenceChunks, scope), eq(mediaEvidenceChunks.snapshotId, snapshotId))).orderBy(asc(mediaEvidenceChunks.ordinal));
  for (const chunk of chunks) {
    let reference = chunk.objectVersion ? { objectVersion: chunk.objectVersion, ciphertextSha256: chunk.ciphertextSha256, sizeBytes: chunk.sizeBytes } : null;
    if (!reference) {
      if (!chunk.spool) throw new Error('MEDIA_EVIDENCE_CHUNK_SPOOL_MISSING');
      const bytes = Buffer.from(canonicalJson(chunk.spool));
      try { if (hash(bytes) !== chunk.ciphertextSha256 || bytes.length !== chunk.sizeBytes) throw new Error('MEDIA_EVIDENCE_CHUNK_SPOOL_CORRUPT'); reference = await store.putImmutable(chunk.objectKey, bytes); } finally { bytes.fill(0); }
    }
    const observed = await store.readVersion(chunk.objectKey, reference);
    try { if (hash(observed) !== chunk.ciphertextSha256 || observed.length !== chunk.sizeBytes) throw new Error('MEDIA_EVIDENCE_CHUNK_VERSION_CHANGED'); } finally { observed.fill(0); }
    // Only the exact immutable version is recorded. Parent remains PENDING until every chunk verifies.
    await db.update(mediaEvidenceChunks).set({ objectVersion: reference.objectVersion, spool: null }).where(and(eq(mediaEvidenceChunks.id, chunk.id), eq(mediaEvidenceChunks.ciphertextSha256, reference.ciphertextSha256)));
  }
}
export async function readLayeredEvidence(scope: TenantScope, snapshotId: string, raw: unknown, store: ArchiveObjectStore) {
  const manifest = layeredManifestSchema.parse(raw);
  const rows = await db.select().from(mediaEvidenceChunks).where(and(scopePredicate(mediaEvidenceChunks, scope), eq(mediaEvidenceChunks.snapshotId, snapshotId))).orderBy(asc(mediaEvidenceChunks.ordinal));
  if (rows.length !== manifest.parts.length) throw new Error('MEDIA_EVIDENCE_CHUNKS_INCOMPLETE');
  const parts: Buffer[] = []; let total = 0;
  try {
    for (const [index, ref] of manifest.parts.entries()) {
      const row = rows[index];
      if (ref.ordinal !== index || row.id !== ref.id || row.ordinal !== index || row.plaintextSha256 !== ref.plaintextSha256 || row.plaintextBytes !== ref.plaintextBytes || !row.objectVersion) throw new Error('MEDIA_EVIDENCE_CHUNK_IDENTITY_CHANGED');
      const encoded = await store.readVersion(row.objectKey, { objectVersion: row.objectVersion, ciphertextSha256: row.ciphertextSha256, sizeBytes: row.sizeBytes });
      try {
        const chunk = z.object({ version: z.literal('media-evidence-chunk-1'), snapshotId: z.string(), ordinal: z.number(), data: z.string().max(2 * PART_BYTES) }).strict().parse(openReceipt(JSON.parse(Buffer.from(encoded).toString('utf8')) as SecretEnvelope[], 'media-evidence-chunk:' + row.id));
        if (chunk.snapshotId !== snapshotId || chunk.ordinal !== index) throw new Error('MEDIA_EVIDENCE_CHUNK_SCOPE_CHANGED');
        const bytes = Buffer.from(chunk.data, 'base64');
        if (hash(bytes) !== ref.plaintextSha256 || bytes.length !== ref.plaintextBytes) throw new Error('MEDIA_EVIDENCE_CHUNK_DIGEST_CHANGED');
        total += bytes.length; if (total > MAX_MEDIA_EVIDENCE_BYTES) throw new Error('MEDIA_EVIDENCE_TOTAL_BUDGET_EXCEEDED'); parts.push(bytes);
      } finally { encoded.fill(0); }
    }
    const text = Buffer.concat(parts).toString('utf8');
    if (total !== manifest.totalBytes || hash(text) !== manifest.plaintextSha256) throw new Error('MEDIA_EVIDENCE_MANIFEST_DIGEST_CHANGED');
    const payload = evidenceSnapshotSchema.parse(JSON.parse(text)); if (payload.jobId !== manifest.jobId) throw new Error('MEDIA_EVIDENCE_MANIFEST_JOB_CHANGED'); return payload;
  } finally { parts.forEach(part => part.fill(0)); }
}
export async function deleteEvidenceChunks(scope: TenantScope, snapshotId: string, store: ArchiveObjectStore) {
  const rows = await db.select().from(mediaEvidenceChunks).where(and(scopePredicate(mediaEvidenceChunks, scope), eq(mediaEvidenceChunks.snapshotId, snapshotId)));
  for (const row of rows) {
    if (!row.objectVersion) throw new Error('MEDIA_EVIDENCE_CHUNK_VERSION_MISSING');
    await store.deleteVersion(row.objectKey, row.objectVersion);
  }
  return rows.map(row => ({ id: row.id, objectVersion: row.objectVersion, ciphertextSha256: row.ciphertextSha256 }));
}
