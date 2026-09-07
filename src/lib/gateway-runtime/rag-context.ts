import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '@/lib/api-security';
import { retrieveGuardedRagContext, assertRagRetrievalAccess, ragClearance } from '@/lib/rag/retrieval';
import { ragReferenceDigest } from '@/lib/rag/reference-binding';
import { db } from '@/storage/database/shared/db';
import { artifacts, ragChunks, ragSources } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import type { ContentSegment } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, extractSegments, GatewayError, type JsonValue } from './protocol';
import { evidenceHmac, verifyPayload } from './security';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ragOptionsSchema = z.object({
  sourceIds: z.array(z.string().uuid()).min(1).max(20), maximumCandidates: z.number().int().min(1).max(20).default(5), minimumTrustLevel: z.number().int().min(0).max(100).default(0),
}).strict();
export const ragContextProofSchema = z.object({
  manifest: z.object({
    contractVersion: z.literal('1.0'), tenantId: z.string(), applicationId: z.string(), subjectId: z.string(), requestId: z.string(), bundleId: z.string(),
    principalClaimsHmac: digest, contextHmac: digest, issuedAt: z.number().int(), expiresAt: z.number().int(),
    sourceReferences: z.array(z.object({
      sourceId: z.string().uuid(), chunkId: z.string(), sourceVersion: z.string(), contentHash: digest, instructionCapability: z.literal('FORBIDDEN'), trustLevel: z.literal('UNTRUSTED'),
      textLength: z.number().int().nonnegative(), chunkRecordId: z.string().uuid(), artifactId: z.string().uuid(), bindingDigest: digest,
    }).strict()).min(1).max(20),
  }).strict(), keyId: z.string(), signature: z.string(),
}).strict();
export type GatewayRagContextProof = z.infer<typeof ragContextProofSchema>;

export function splitRagRequest(value: JsonValue): { request: Record<string, JsonValue>; rag?: z.infer<typeof ragOptionsSchema> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('REQUEST_OBJECT_REQUIRED', 400);
  const { guard_rag: raw, ...request } = value;
  if (raw === undefined) return { request };
  return { request, rag: ragOptionsSchema.parse(raw) };
}

export async function materializeRagRequest(input: {
  request: Record<string, JsonValue>; options: z.infer<typeof ragOptionsSchema>; scope: TenantScope; principal: AuthenticatedPrincipal;
  requestId: string; traceId: string; bundleId: string; deadline: number; maxInputChars: number; signal: AbortSignal;
}): Promise<{ request: Record<string, JsonValue>; segments: ContentSegment[]; proof: GatewayRagContextProof }> {
  const originalSegments = extractSegments(input.request, 'INPUT', input.maxInputChars);
  if (!Array.isArray(input.request.messages)) throw new GatewayError('MESSAGES_INVALID', 400);
  const messages = [...input.request.messages];
  const userIndex = messages.findLastIndex(item => Boolean(item && typeof item === 'object' && !Array.isArray(item) && item.role === 'user'));
  const query = originalSegments.filter(segment => segment.role === 'user' && segment.contentPath.startsWith('/messages/' + userIndex + '/')).map(segment => segment.text).join('\n');
  if (!query || query.length > 32768) throw new GatewayError('RAG_QUERY_BUDGET_INVALID', 413);
  const retrieval = await retrieveGuardedRagContext({ ...input.options, scope: input.scope, principal: { id: input.principal.subject, roles: input.principal.roles, clearance: ragClearance(input.principal.roles) },
    requestId: input.requestId, traceId: input.traceId, bundleId: input.bundleId, query, absoluteDeadlineEpochMs: input.deadline, signal: input.signal });
  if (!['ALLOW', 'WARN'].includes(retrieval.action) || retrieval.approvedContext.length === 0) throw new GatewayError('RAG_CONTEXT_NOT_APPROVED', 403);
  const proof = ragContextProofSchema.parse(retrieval.proof);
  if (proof.manifest.contextHmac !== evidenceHmac(canonicalJson(retrieval.approvedContext))) throw new GatewayError('RAG_CONTEXT_PROOF_MISMATCH', 403);
  // References remain untrusted user data in the model protocol; they never gain
  // a system/developer role or permission to issue instructions.
  messages.splice(userIndex, 0, ...retrieval.approvedContext.map(context => ({ role: 'user', content: JSON.stringify({ kind: 'untrusted_rag_reference', sourceId: context.sourceId, chunkId: context.chunkId, sourceVersion: context.sourceVersion, instructionCapability: 'FORBIDDEN', text: context.text }) })));
  const request = { ...input.request, messages };
  const segments = extractSegments(request, 'INPUT', input.maxInputChars).map(segment => {
    const messageIndex = Number(segment.contentPath.split('/')[2]);
    return messageIndex >= userIndex && messageIndex < userIndex + retrieval.approvedContext.length && segment.contentPath.startsWith('/messages/') ? { ...segment, sourceType: 'RAG' as const } : segment;
  });
  return { request, segments, proof };
}

/** Revalidate references at each privileged execution boundary without rereading source text. */
export async function assertRagContextActive(proof: GatewayRagContextProof, input: TenantScope & { subjectId: string; roles: readonly string[]; requestId: string; bundleId: string }): Promise<void> {
  const manifest = proof.manifest;
  verifyPayload('gateway-rag-context-v1', manifest, proof.keyId, proof.signature);
  const principal = { id: input.subjectId, roles: input.roles, clearance: ragClearance(input.roles) };
  if (manifest.tenantId !== input.tenantId || manifest.applicationId !== input.applicationId || manifest.subjectId !== input.subjectId || manifest.requestId !== input.requestId || manifest.bundleId !== input.bundleId
    || manifest.expiresAt <= Date.now() || manifest.issuedAt > Date.now() + 1000 || manifest.principalClaimsHmac !== evidenceHmac(canonicalJson(principal))) throw new GatewayError('RAG_CONTEXT_AUTHORIZATION_CHANGED', 403);
  const references = manifest.sourceReferences;
  const rows = await db.select({ chunk: ragChunks, source: ragSources, artifact: artifacts }).from(ragChunks)
    .innerJoin(ragSources, and(eq(ragChunks.sourceId, ragSources.id), eq(ragChunks.tenantId, ragSources.tenantId), eq(ragChunks.applicationId, ragSources.applicationId)))
    .innerJoin(artifacts, and(eq(ragChunks.artifactId, artifacts.id), eq(ragChunks.tenantId, artifacts.tenantId), eq(ragChunks.applicationId, artifacts.applicationId)))
    .where(and(scopePredicate(ragChunks, input), inArray(ragChunks.id, references.map(reference => reference.chunkRecordId))));
  if (rows.length !== references.length) throw new GatewayError('RAG_REFERENCE_REVOKED', 403);
  for (const reference of references) {
    const row = rows.find(value => value.chunk.id === reference.chunkRecordId);
    if (!row || row.source.id !== reference.sourceId || row.artifact.id !== reference.artifactId || row.chunk.externalChunkId !== reference.chunkId
      || row.chunk.contentHash !== reference.contentHash || ragReferenceDigest(row) !== reference.bindingDigest || row.artifact.contentExpiresAt <= new Date()) throw new GatewayError('RAG_REFERENCE_REVOKED', 403);
    assertRagRetrievalAccess({ scope: input, principal, source: row.source });
  }
}
