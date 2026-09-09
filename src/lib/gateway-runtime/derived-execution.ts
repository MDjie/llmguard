import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { artifacts, artifactParts, guardJobs } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { validateIntakeBinding } from '@/lib/guard-jobs/intake-binding';
import { readAcceptedTextArtifact } from '@/lib/artifacts/text-reader';
import { readNormalizedAsset } from '@/lib/artifacts/normalized';
import { normalizedAssetSchema, normalizedText, NORMALIZED_MAX_BYTES } from '@/lib/artifacts/normalized-contract';
import { extensionOf } from '@/lib/media/formats/registry';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { nativeBindingSchema, nativeAssessmentSchema } from '@/contracts/http/native-multimodal';
import { evaluateNativeAssessment } from '@/lib/multimodal/native-gate';
import { assertCurrentJointEvidence } from '@/lib/multimodal/joint-evidence-judge';
import { canonicalJson, GatewayError, sha256, type JsonValue } from './protocol';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const profileSchema = z.object({
  kind: z.enum(['TEXT','DOCUMENT','IMAGE','AUDIO','VIDEO']), extension: z.string().regex(/^[a-z0-9]{1,20}$/),
  mediaType: z.string().min(1).max(200), transformVersion: z.string().min(1).max(512),
}).strict();
export const derivedRouteAdapterSchema = z.object({
  tenantId: z.string().min(1), applicationId: z.string().min(1), modelRoute: z.string().min(1).max(128),
  routingDigest: hash, bundleDigest: hash, formatVersion: z.literal('chat-text-projection-1'),
  profiles: z.array(profileSchema).min(1).max(100),
  maximumBytes: z.number().int().positive().max(NORMALIZED_MAX_BYTES),
  validUntil: z.iso.datetime(), approvalRef: z.string().min(1).max(128),
}).strict();
export const derivedExecutionProofSchema = z.object({
  jobId: z.uuid(), jobDigest: hash, contextDigest: hash, requestDigest: hash,
  modelRoute: z.string().min(1).max(128), routingDigest: hash, bundleDigest: hash, adapterDigest: hash,
  sources: z.array(normalizedAssetSchema).min(1).max(8),
}).strict();
export type DerivedExecutionProof = z.infer<typeof derivedExecutionProofSchema>;
type Reference = { artifactId: string; sha256: string };
type Input = TenantScope & {
  subjectId: string; bundleId: string; jobId: string; contextDigest: string; modelRoute: string; routingDigest: string;
  references: readonly Reference[]; signal?: AbortSignal;
};
const resultSchema = z.object({
  action: z.enum(['ALLOW','WARN']), operationalOutcome: z.literal('COMPLETE'), degraded: z.literal(false),
  contextDigest: hash, releaseEligibility: z.object({ eligible: z.literal(true) }).loose(),
  normalizedAssets: z.array(normalizedAssetSchema).min(1).max(8),
}).loose();

/** Qualified adapters describe one exact target route and transform/profile set. Missing or ambiguous entries fail closed. */
export function selectDerivedRouteAdapter(input: TenantScope & { modelRoute: string; routingDigest: string; bundleDigest: string }, profiles: z.infer<typeof profileSchema>[]) {
  let entries: z.infer<typeof derivedRouteAdapterSchema>[];
  try { entries = z.array(derivedRouteAdapterSchema).max(1000).parse(JSON.parse(process.env.DERIVED_MEDIA_ROUTE_ADAPTERS_JSON ?? '[]')); }
  catch { throw new GatewayError('DERIVED_ROUTE_ADAPTER_INVALID', 503); }
  const candidates = entries.filter(entry => entry.tenantId === input.tenantId && entry.applicationId === input.applicationId &&
    entry.modelRoute === input.modelRoute && entry.routingDigest === input.routingDigest && entry.bundleDigest === input.bundleDigest &&
    Date.parse(entry.validUntil) > Date.now());
  if (candidates.length !== 1 || !profiles.every(profile => candidates[0].profiles.some(allowed => canonicalJson(allowed) === canonicalJson(profile)))) {
    throw new GatewayError('DERIVED_ROUTE_NOT_QUALIFIED', 403);
  }
  return candidates[0];
}

async function sourceBindings(input: Input, sources: z.infer<typeof normalizedAssetSchema>[]) {
  const ids = [...new Set(sources.flatMap(source => [source.parentArtifactId, source.artifactId]))];
  const rows = await db.select().from(artifacts).where(and(scopePredicate(artifacts, input), eq(artifacts.ownerId, input.subjectId), inArray(artifacts.id, ids)));
  if (rows.length !== ids.length) throw new GatewayError('DERIVED_SOURCE_UNAVAILABLE', 403);
  const bindings: Array<Reference & { bindingDigest: string; bytes: number }> = [];
  for (const source of sources) {
    const parent = rows.find(row => row.id === source.parentArtifactId)!, child = rows.find(row => row.id === source.artifactId)!;
    if ([parent,child].some(row => row.state !== 'accepted' || !row.verifiedSha256 || row.verifiedSize === null || row.contentExpiresAt <= new Date()) ||
      parent.verifiedSha256 !== source.parentSha256 || child.verifiedSha256 !== source.sha256 || child.kind !== 'TEXT' || child.contentExpiresAt > parent.contentExpiresAt) {
      throw new GatewayError('DERIVED_SOURCE_CHANGED', 403);
    }
    const objects = [];
    for (const row of [parent, child]) {
      const parts = await db.select({ number: artifactParts.partNumber, key: artifactParts.objectKey, hash: artifactParts.sha256, bytes: artifactParts.sizeBytes, state: artifactParts.state })
        .from(artifactParts).where(and(scopePredicate(artifactParts, input), eq(artifactParts.artifactId, row.id))).orderBy(asc(artifactParts.partNumber));
      if (parts.length !== row.partCount || parts.some((part,index) => part.number !== index + 1 || part.state !== 'verified') ||
        parts.reduce((total,part) => total + part.bytes,0) !== row.verifiedSize) throw new GatewayError('DERIVED_PART_MANIFEST_CHANGED', 403);
      objects.push({ id:row.id, owner:row.ownerId, kind:row.kind, sha256:row.verifiedSha256, bytes:row.verifiedSize, fileName:row.fileName,
        mediaType:row.detectedMediaType, expiresAt:row.contentExpiresAt.getTime(), parts });
    }
    bindings.push({ artifactId:parent.id, sha256:source.parentSha256, bytes:parent.verifiedSize!, bindingDigest:sha256(canonicalJson({source,objects})) });
  }
  return { bindings, rows };
}

/** Rebuild the same text-only wire from owned immutable objects at every inspection/release point. */
export async function prepareDerivedExecution(input: Input) {
  input.signal?.throwIfAborted();
  const [job] = await db.select().from(guardJobs).where(and(scopePredicate(guardJobs,input), eq(guardJobs.ownerId,input.subjectId),
    eq(guardJobs.id,input.jobId), eq(guardJobs.jobType,'intake'), eq(guardJobs.status,'completed'))).limit(1);
  if (!job || job.bundleId !== input.bundleId || !job.completedAt || job.cancelledAt ||
    Date.now() - job.completedAt.getTime() > 600000 || job.completedAt.getTime() > Date.now() + 1000) throw new GatewayError('DERIVED_EXECUTION_JOB_UNAVAILABLE',403);
  const result = resultSchema.safeParse(job.result);
  if (!result.success || result.data.normalizedAssets.some(source => !source.complete)) throw new GatewayError('DERIVED_EXECUTION_REQUIRES_REVIEW',403);
  const current = await validateIntakeBinding(input,input.subjectId,job.executionBinding);
  if (!current.binding.context || current.binding.context.artifactId !== job.contextArtifactId ||
    current.binding.context.sha256 !== input.contextDigest || result.data.contextDigest !== input.contextDigest) throw new GatewayError('DERIVED_CONTEXT_MISMATCH',403);
  const sources = result.data.normalizedAssets;
  const originalRefs = current.binding.artifacts.map(source => ({artifactId:source.id,sha256:source.sha256}));
  if (canonicalJson(originalRefs) !== canonicalJson(input.references.map(ref => ({artifactId:ref.artifactId,sha256:ref.sha256}))) ||
    canonicalJson(sources.map(source => ({artifactId:source.parentArtifactId,sha256:source.parentSha256}))) !== canonicalJson(originalRefs)) {
    throw new GatewayError('DERIVED_SOURCE_ORDER_MISMATCH',403);
  }
  const bundle = await loadVerifiedPolicyBundle(input,input.bundleId), bundleDigest = sha256(canonicalJson(bundle.payload));
  if (current.artifacts.some(source => source.kind !== 'TEXT')) {
    const binding = nativeBindingSchema.safeParse(result.data.nativeBinding), assessment = nativeAssessmentSchema.safeParse(result.data.nativeAssessment);
    if (!binding.success || !assessment.success || binding.data.tenantId !== input.tenantId || binding.data.applicationId !== input.applicationId ||
      binding.data.bundleDigest !== bundleDigest || binding.data.direction !== 'INPUT' ||
      canonicalJson([...binding.data.requiredRiskIds].sort()) !== canonicalJson([...(bundle.payload.semanticCoverage?.requiredRiskIds ?? [])].sort()) ||
      !evaluateNativeAssessment(binding.data,assessment.data).eligible) throw new GatewayError('DERIVED_NATIVE_QUALIFICATION_REQUIRED',403);
    const expected = current.artifacts.filter(source => source.kind !== 'TEXT').map(source => ({artifactId:source.id,sha256:source.verifiedSha256}));
    const actual = binding.data.sources.filter(source => source.modality !== 'TEXT').map(source => ({artifactId:source.artifactId,sha256:source.sha256}));
    if (canonicalJson(expected) !== canonicalJson(actual)) throw new GatewayError('DERIVED_NATIVE_SOURCE_MISMATCH',403);
    try { assertCurrentJointEvidence(binding.data,result.data.jointEvidence); }
    catch { throw new GatewayError('DERIVED_JOINT_RECHECK_REQUIRED',403); }
  }
  const profiles = sources.map((source,index) => ({kind:current.binding.artifacts[index].kind,extension:extensionOf(current.artifacts[index].fileName),
    mediaType:current.binding.artifacts[index].mediaType,transformVersion:source.transformVersion}));
  const adapter = selectDerivedRouteAdapter({...input,bundleDigest},profiles);
  const raw = await readAcceptedTextArtifact(input,current.binding.context.artifactId,256*1024,['TEXT'],input.signal);
  if (sha256(raw) !== input.contextDigest) throw new GatewayError('DERIVED_CONTEXT_CHANGED',403);
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GatewayError('DERIVED_CONTEXT_INVALID',403);
  const request = parsed as Record<string,JsonValue>;
  if (canonicalJson(request) !== raw || request.model !== input.modelRoute || !Array.isArray(request.messages) || 'guard_artifacts' in request || 'guard_rag' in request) throw new GatewayError('DERIVED_CONTEXT_INVALID',403);
  const before = await sourceBindings(input,sources);
  const contents: Record<string,JsonValue>[] = [], archiveData: Record<string,unknown>[] = [];
  for (const [index,source] of sources.entries()) {
    input.signal?.throwIfAborted();
    const document = await readNormalizedAsset(input,input.subjectId,source,input.signal);
    if (document.sourceKind !== current.binding.artifacts[index].kind) throw new GatewayError('DERIVED_SOURCE_KIND_CHANGED',403);
    const projection = normalizedText(document);
    if (!projection.text.length) throw new GatewayError('DERIVED_TEXT_EMPTY',422);
    const data = {kind:'untrusted_file_projection',formatVersion:adapter.formatVersion,...source,instructionCapability:'FORBIDDEN',text:projection.text};
    contents.push({role:'user',content:canonicalJson(data)});
    archiveData.push({...data,mappings:projection.mappings,coordinateMappings:document.coordinateMappings});
  }
  const messages = [...request.messages], insertionIndex = messages.findLastIndex(message => Boolean(message && typeof message === 'object' && !Array.isArray(message) && message.role === 'user'));
  if (insertionIndex < 0) throw new GatewayError('ARTIFACT_USER_QUERY_REQUIRED',400);
  messages.splice(insertionIndex,0,...contents);
  const prepared = {...request,messages}, serialized = canonicalJson(prepared);
  if (Buffer.byteLength(serialized,'utf8') > adapter.maximumBytes) throw new GatewayError('DERIVED_WIRE_BUDGET_EXCEEDED',413);
  const after = await sourceBindings(input,sources);
  if (canonicalJson(before.bindings) !== canonicalJson(after.bindings)) throw new GatewayError('DERIVED_SOURCE_CHANGED',403);
  input.signal?.throwIfAborted();
  const proof = derivedExecutionProofSchema.parse({jobId:job.id,jobDigest:sha256(canonicalJson(job.result)),contextDigest:input.contextDigest,
    requestDigest:sha256(serialized),modelRoute:input.modelRoute,routingDigest:input.routingDigest,bundleDigest,adapterDigest:sha256(canonicalJson(adapter)),sources});
  return {request:prepared,proof,references:after.bindings,archiveData,insertionIndex};
}
