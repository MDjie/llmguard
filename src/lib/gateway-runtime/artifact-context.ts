import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { artifacts, artifactParts } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { readAcceptedTextArtifact } from '@/lib/artifacts/text-reader';
import type { ContentSegment } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, extractSegments, GatewayError, sha256, type JsonValue } from './protocol';
import { signPayload, verifyPayload } from './security';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema = z.object({ artifactId: z.string().uuid(), sha256: hash }).strict();
const optionsSchema = z.array(referenceSchema).min(1).max(8).refine(values => new Set(values.map(v => v.artifactId)).size === values.length);
export const artifactContextProofSchema = z.object({ manifest: z.object({
  version: z.literal('1.0'), tenantId: z.string(), applicationId: z.string(), subjectId: z.string(), requestId: z.string(), bundleId: z.string(),
  issuedAt: z.number().int(), expiresAt: z.number().int(),
  references: z.array(referenceSchema.extend({ bindingDigest: hash, bytes: z.number().int().nonnegative() }).strict()).min(1).max(8),
}).strict(), keyId: z.string(), signature: z.string() }).strict();
export type ArtifactContextProof = z.infer<typeof artifactContextProofSchema>;
type Context = TenantScope & { subjectId: string; requestId: string; bundleId: string };

export function splitArtifactRequest(value: Record<string, JsonValue>) {
  const { guard_artifacts: raw, ...request } = value;
  return { request, ...(raw === undefined ? {} : { references: optionsSchema.parse(raw) }) };
}

async function ownedBinding(input: Context, id: string) {
  const [artifact] = await db.select().from(artifacts).where(and(scopePredicate(artifacts, input), eq(artifacts.id, id), eq(artifacts.ownerId, input.subjectId))).limit(1);
  if (!artifact || artifact.state !== 'accepted' || !artifact.verifiedSha256 || artifact.verifiedSize === null || artifact.contentExpiresAt <= new Date()) throw new GatewayError('ARTIFACT_REFERENCE_UNAVAILABLE', 403);
  // Native media and document URLs are not silently reduced to a text-only check.
  if (artifact.kind !== 'TEXT') throw new GatewayError('ARTIFACT_ASYNC_ANALYSIS_REQUIRED', 422);
  if (artifact.verifiedSize > 1048576) throw new GatewayError('ARTIFACT_REFERENCE_BUDGET_EXCEEDED', 413);
  const parts = await db.select({ number: artifactParts.partNumber, key: artifactParts.objectKey, hash: artifactParts.sha256, bytes: artifactParts.sizeBytes, state: artifactParts.state }).from(artifactParts).where(and(scopePredicate(artifactParts, input), eq(artifactParts.artifactId, id))).orderBy(asc(artifactParts.partNumber));
  if (parts.length !== artifact.partCount || parts.some((part, i) => part.number !== i + 1 || part.state !== 'verified') || parts.reduce((sum, part) => sum + part.bytes, 0) !== artifact.verifiedSize) throw new GatewayError('ARTIFACT_REFERENCE_MANIFEST_INVALID', 403);
  return { artifact, bindingDigest: sha256(canonicalJson({ id, owner: artifact.ownerId, kind: artifact.kind, state: artifact.state, sha256: artifact.verifiedSha256, bytes: artifact.verifiedSize, type: artifact.detectedMediaType, expires: artifact.contentExpiresAt.getTime(), parts })) };
}

export async function materializeArtifactRequest(input: Context & {
  request: Record<string, JsonValue>; sourceSegments: ContentSegment[]; references: z.infer<typeof optionsSchema>; deadline: number; maxInputChars: number; signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const proofReferences: ArtifactContextProof['manifest']['references'] = [];
  const contents: Record<string, JsonValue>[] = [];
  let bytes = 0;
  for (const reference of input.references) {
    const before = await ownedBinding(input, reference.artifactId);
    if (reference.sha256 !== before.artifact.verifiedSha256) throw new GatewayError('ARTIFACT_REFERENCE_DIGEST_MISMATCH', 403);
    bytes += before.artifact.verifiedSize!;
    if (bytes > 1048576) throw new GatewayError('ARTIFACT_REFERENCE_BUDGET_EXCEEDED', 413);
    const text = await readAcceptedTextArtifact(input, reference.artifactId, 1048576, ['TEXT'], input.signal);
    const after = await ownedBinding(input, reference.artifactId);
    if (before.bindingDigest !== after.bindingDigest || sha256(text) !== reference.sha256) throw new GatewayError('ARTIFACT_REFERENCE_CHANGED', 403);
    contents.push({ role: 'user', content: JSON.stringify({ kind: 'untrusted_file_reference', artifactId: reference.artifactId, sha256: reference.sha256, instructionCapability: 'FORBIDDEN', text }) });
    proofReferences.push({ ...reference, bindingDigest: after.bindingDigest, bytes: after.artifact.verifiedSize! });
  }
  if (!Array.isArray(input.request.messages)) throw new GatewayError('MESSAGES_INVALID', 400);
  const messages = [...input.request.messages];
  const index = messages.findLastIndex(value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.role === 'user'));
  if (index < 0) throw new GatewayError('ARTIFACT_USER_QUERY_REQUIRED', 400);
  messages.splice(index, 0, ...contents);
  const request = { ...input.request, messages };
  const sources = new Map(input.sourceSegments.map(segment => [segment.contentPath.replace(/^\/messages\/(\d+)\//u, (_match: string, n: string) => '/messages/' + (Number(n) >= index ? Number(n) + contents.length : Number(n)) + '/'), segment.sourceType]));
  const segments = extractSegments(request, 'INPUT', input.maxInputChars).map(segment => {
    const messageIndex = Number(segment.contentPath.split('/')[2]);
    return { ...segment, sourceType: messageIndex >= index && messageIndex < index + contents.length ? 'FILE' as const : sources.get(segment.contentPath) ?? segment.sourceType };
  });
  const manifest: ArtifactContextProof['manifest'] = { version: '1.0', tenantId: input.tenantId, applicationId: input.applicationId, subjectId: input.subjectId, requestId: input.requestId, bundleId: input.bundleId, issuedAt: Date.now(), expiresAt: input.deadline, references: proofReferences };
  const proof = { manifest, ...signPayload('gateway-artifact-context-v1', manifest) };
  input.signal.throwIfAborted();
  return { request, segments, proof };
}

export async function assertArtifactContextActive(proof: ArtifactContextProof, input: Context): Promise<void> {
  const m = proof.manifest;
  verifyPayload('gateway-artifact-context-v1', m, proof.keyId, proof.signature);
  if (m.tenantId !== input.tenantId || m.applicationId !== input.applicationId || m.subjectId !== input.subjectId || m.requestId !== input.requestId || m.bundleId !== input.bundleId || m.expiresAt <= Date.now() || m.issuedAt > Date.now() + 1000) throw new GatewayError('ARTIFACT_CONTEXT_BINDING_INVALID', 403);
  for (const ref of m.references) {
    const current = await ownedBinding(input, ref.artifactId);
    if (ref.bindingDigest !== current.bindingDigest || ref.sha256 !== current.artifact.verifiedSha256 || ref.bytes !== current.artifact.verifiedSize) throw new GatewayError('ARTIFACT_REFERENCE_CHANGED', 403);
  }
}
