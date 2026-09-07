import type { EvidenceView } from '@/contracts/http/media-evidence';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { artifacts, artifactParts, conversationArchives, gatewayRequests } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { readAcceptedTextArtifact } from '@/lib/artifacts/text-reader';
import type { ContentSegment } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, extractSegments, GatewayError, sha256, type JsonValue } from './protocol';
import { readAcceptedArtifactBytes } from '@/lib/artifacts/binary-reader';
import { mediaEvidenceId, readMediaEvidence } from '@/lib/evidence/media-snapshots';
import { writeArchiveContent } from '@/lib/conversation-archive/service';
import { nativeMediaBlock, type NativeMediaKind } from './native-content';
import { nativeExecutionProofSchema, validateNativeExecutionJob } from './native-execution';
import { signPayload, verifyPayload } from './security';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema = z.object({ artifactId: z.string().uuid(), sha256: hash, jobId: z.uuid().optional() }).strict();
const optionsSchema = z.array(referenceSchema).min(1).max(8).refine(values => new Set(values.map(v => v.artifactId)).size === values.length);
export const artifactContextProofSchema = z.object({ manifest: z.object({
  version: z.literal('1.0'), tenantId: z.string(), applicationId: z.string(), subjectId: z.string(), requestId: z.string(), bundleId: z.string(),
  issuedAt: z.number().int(), expiresAt: z.number().int(), nativeExecution: nativeExecutionProofSchema.optional(),
  references: z.array(referenceSchema.extend({ bindingDigest: hash, bytes: z.number().int().nonnegative() }).strict()).min(1).max(8),
}).strict(), keyId: z.string(), signature: z.string() }).strict();
export type ArtifactContextProof = z.infer<typeof artifactContextProofSchema>;
type Context = TenantScope & { subjectId: string; requestId: string; bundleId: string };

export function splitArtifactRequest(value: Record<string, JsonValue>) {
  const { guard_artifacts: raw, ...request } = value;
  return { request, ...(raw === undefined ? {} : { references: optionsSchema.parse(raw) }) };
}

async function ownedBinding(input: Context, id: string, native = false) {
  const [artifact] = await db.select().from(artifacts).where(and(scopePredicate(artifacts, input), eq(artifacts.id, id), eq(artifacts.ownerId, input.subjectId))).limit(1);
  if (!artifact || artifact.state !== 'accepted' || !artifact.verifiedSha256 || artifact.verifiedSize === null || artifact.contentExpiresAt <= new Date()) throw new GatewayError('ARTIFACT_REFERENCE_UNAVAILABLE', 403);
  // Native media and document URLs are not silently reduced to a text-only check.
  if (native ? !['IMAGE','AUDIO','VIDEO'].includes(artifact.kind) : artifact.kind !== 'TEXT') throw new GatewayError('ARTIFACT_ASYNC_ANALYSIS_REQUIRED', 422);
  if (artifact.verifiedSize > 1048576) throw new GatewayError('ARTIFACT_REFERENCE_BUDGET_EXCEEDED', 413);
  const parts = await db.select({ number: artifactParts.partNumber, key: artifactParts.objectKey, hash: artifactParts.sha256, bytes: artifactParts.sizeBytes, state: artifactParts.state }).from(artifactParts).where(and(scopePredicate(artifactParts, input), eq(artifactParts.artifactId, id))).orderBy(asc(artifactParts.partNumber));
  if (parts.length !== artifact.partCount || parts.some((part, i) => part.number !== i + 1 || part.state !== 'verified') || parts.reduce((sum, part) => sum + part.bytes, 0) !== artifact.verifiedSize) throw new GatewayError('ARTIFACT_REFERENCE_MANIFEST_INVALID', 403);
  return { artifact, bindingDigest: sha256(canonicalJson({ id, owner: artifact.ownerId, kind: artifact.kind, state: artifact.state, sha256: artifact.verifiedSha256, bytes: artifact.verifiedSize, type: artifact.detectedMediaType, expires: artifact.contentExpiresAt.getTime(), parts })) };
}

export async function materializeArtifactRequest(input: Context & {
  archiveRequired?: boolean; modelRoute?: string; routingDigest?: string; request: Record<string, JsonValue>; sourceSegments: ContentSegment[]; references: z.infer<typeof optionsSchema>; deadline: number; maxInputChars: number; signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const proofReferences: ArtifactContextProof['manifest']['references'] = [];
  const native = input.references.some(ref => ref.jobId !== undefined);
  let derivedViews:EvidenceView[]=[],derivedMappings:Record<string,unknown>[]=[];
  let nativeExecution: z.infer<typeof nativeExecutionProofSchema> | undefined;
  if (native) {
    const jobId = input.references[0].jobId;
    if (!jobId || input.references.some(ref => ref.jobId !== jobId)) throw new GatewayError('NATIVE_JOB_REFERENCE_MISMATCH', 403);
    if (!input.archiveRequired) throw new GatewayError('NATIVE_ARCHIVE_REQUIRED', 403);
    if (!input.modelRoute || !input.routingDigest) throw new GatewayError('NATIVE_ROUTE_BINDING_REQUIRED', 403);
    nativeExecution = await validateNativeExecutionJob({ ...input, jobId, contextDigest: sha256(canonicalJson(input.request)), modelRoute: input.modelRoute, routingDigest: input.routingDigest, references: input.references.map(ref => ({ artifactId: ref.artifactId, sha256: ref.sha256 })) });
    const derived=await readMediaEvidence(input,mediaEvidenceId(input,jobId));
    derivedViews=derived.content.views;derivedMappings=derived.content.mappings;
    if(derived.content.bundleId!==input.bundleId)throw new GatewayError('NATIVE_EVIDENCE_POLICY_MISMATCH',403);
    await writeArchiveContent(input,{requestId:input.requestId,purpose:'RECEIVED_INPUT',sequence:input.references.length+2,representation:'CONTENT_SEGMENTS',data:derived.content},undefined,input.signal);
  }
  const contents: Record<string, JsonValue>[] = [];
  let bytes = 0;
  for (const reference of input.references) {
    const before = await ownedBinding(input, reference.artifactId, native);
    if (reference.sha256 !== before.artifact.verifiedSha256) throw new GatewayError('ARTIFACT_REFERENCE_DIGEST_MISMATCH', 403);
    bytes += before.artifact.verifiedSize!;
    if (bytes > 1048576) throw new GatewayError('ARTIFACT_REFERENCE_BUDGET_EXCEEDED', 413);
    let archiveData: unknown;
    if (native) {
      const raw = await readAcceptedArtifactBytes(input, reference.artifactId, 1048576, ['IMAGE','AUDIO','VIDEO'], input.signal);
      try {
        const block = nativeMediaBlock(before.artifact.kind as NativeMediaKind, before.artifact.detectedMediaType ?? '', raw);
        contents.push(block);
        archiveData = { artifactId: reference.artifactId, sha256: reference.sha256, mimeType: before.artifact.detectedMediaType, provenance:{version:'media-source-provenance-1',jobId:reference.jobId,artifactId:reference.artifactId,sourceDigest:reference.sha256,views:derivedViews.filter(view=>view.artifactId===reference.artifactId).map(({text:_text,source:_source,...location})=>location),mappings:derivedMappings.filter(mapping=>mapping.artifactId===reference.artifactId)}, dataBase64: Buffer.from(raw).toString('base64') };
      } finally { raw.fill(0); }
    } else {
      const text = await readAcceptedTextArtifact(input, reference.artifactId, 1048576, ['TEXT'], input.signal);
      if (sha256(text) !== reference.sha256) throw new GatewayError('ARTIFACT_REFERENCE_CHANGED', 403);
      archiveData = { artifactId: reference.artifactId, sha256: reference.sha256, text };
      contents.push({ role: 'user', content: JSON.stringify({ kind: 'untrusted_file_reference', artifactId: reference.artifactId, sha256: reference.sha256, instructionCapability: 'FORBIDDEN', text }) });
    }
    const after = await ownedBinding(input, reference.artifactId, native);
    if (before.bindingDigest !== after.bindingDigest) throw new GatewayError('ARTIFACT_REFERENCE_CHANGED', 403);
    if (input.archiveRequired) await writeArchiveContent(input, { requestId: input.requestId, purpose: 'RECEIVED_INPUT', sequence: proofReferences.length + 1, representation: native ? 'MEDIA_BYTES' : 'CONTENT_SEGMENTS', data: archiveData }, undefined, input.signal);
    proofReferences.push({ ...reference, bindingDigest: after.bindingDigest, bytes: after.artifact.verifiedSize! });
  }
  if (!Array.isArray(input.request.messages)) throw new GatewayError('MESSAGES_INVALID', 400);
  const messages = [...input.request.messages];
  const index = messages.findLastIndex(value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.role === 'user'));
  if (index < 0) throw new GatewayError('ARTIFACT_USER_QUERY_REQUIRED', 400);
  if (native) {
    const user = messages[index];
    if (!user || typeof user !== 'object' || Array.isArray(user)) throw new GatewayError('ARTIFACT_USER_QUERY_REQUIRED', 400);
    const content = typeof user.content === 'string' ? [{ type: 'text', text: user.content }] : Array.isArray(user.content) ? user.content : [];
    messages[index] = { ...user, content: [...content, ...contents] };
  } else messages.splice(index, 0, ...contents);
  if (input.archiveRequired) await db.transaction(async tx => {
    const [current] = await tx.select({ state: gatewayRequests.preparationState }).from(gatewayRequests).where(and(scopePredicate(gatewayRequests, input), eq(gatewayRequests.id, input.requestId))).for('update');
    if (current?.state !== 'PREPARING') throw new GatewayError('REQUEST_PREPARATION_CLOSED', 409);
    await tx.update(conversationArchives).set({ mediaComplete: true, version: sql`${conversationArchives.version} + 1` }).where(and(scopePredicate(conversationArchives, input), eq(conversationArchives.requestId, input.requestId)));
  });
  const request = { ...input.request, messages };
  const sources = new Map(input.sourceSegments.map(segment => [segment.contentPath.replace(/^\/messages\/(\d+)\//u, (_match: string, n: string) => '/messages/' + (!native && Number(n) >= index ? Number(n) + contents.length : Number(n)) + '/'), segment.sourceType]));
  const segments = extractSegments(request, 'INPUT', input.maxInputChars, native).map(segment => {
    const messageIndex = Number(segment.contentPath.split('/')[2]);
    return { ...segment, sourceType: !native && messageIndex >= index && messageIndex < index + contents.length ? 'FILE' as const : sources.get(segment.contentPath) ?? segment.sourceType };
  });
  const manifest: ArtifactContextProof['manifest'] = { version: '1.0', tenantId: input.tenantId, applicationId: input.applicationId, subjectId: input.subjectId, requestId: input.requestId, bundleId: input.bundleId, issuedAt: Date.now(), expiresAt: input.deadline, references: proofReferences, ...(nativeExecution ? { nativeExecution } : {}) };
  const proof = { manifest, ...signPayload('gateway-artifact-context-v1', manifest) };
  input.signal.throwIfAborted();
  return { request, segments, proof };
}

export async function assertArtifactContextActive(proof: ArtifactContextProof, input: Context): Promise<void> {
  const m = proof.manifest;
  verifyPayload('gateway-artifact-context-v1', m, proof.keyId, proof.signature);
  if (m.tenantId !== input.tenantId || m.applicationId !== input.applicationId || m.subjectId !== input.subjectId || m.requestId !== input.requestId || m.bundleId !== input.bundleId || m.expiresAt <= Date.now() || m.issuedAt > Date.now() + 1000) throw new GatewayError('ARTIFACT_CONTEXT_BINDING_INVALID', 403);
  if (m.nativeExecution) {
    const renewed = await validateNativeExecutionJob({ ...input, ...m.nativeExecution, references: m.references.map(ref => ({ artifactId: ref.artifactId, sha256: ref.sha256 })) });
    if (canonicalJson(renewed) !== canonicalJson(m.nativeExecution)) throw new GatewayError('NATIVE_EXECUTION_CHANGED', 403);
  }
  for (const ref of m.references) {
    const current = await ownedBinding(input, ref.artifactId, Boolean(m.nativeExecution));
    if (ref.bindingDigest !== current.bindingDigest || ref.sha256 !== current.artifact.verifiedSha256 || ref.bytes !== current.artifact.verifiedSize) throw new GatewayError('ARTIFACT_REFERENCE_CHANGED', 403);
  }
}
