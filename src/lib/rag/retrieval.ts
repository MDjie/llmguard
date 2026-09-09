import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { readAcceptedTextArtifact } from '@/lib/artifacts/text-reader';
import { loadRuntimePolicyBundle, loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { evidenceHmac, signPayload } from '@/lib/gateway-runtime/security';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifacts, ragChunks, ragSources, ragRetrievalAudits } from '@/storage/database/shared/schema';
import { guardRagFlow, type RagCandidate, type RagPrincipal } from './flow';
import { validateMediaRagLineage } from './media-lineage';
import { ragContentHash } from './provenance';
import { ragReferenceBinding, ragReferenceDigest } from './reference-binding';

export class RagRetrievalError extends Error {
  constructor(readonly code:string) { super(code);this.name='RagRetrievalError'; }
}
const aclSchema=z.object({
  allowedPrincipals:z.array(z.string()).max(1000).default([]),
  allowedRoles:z.array(z.string()).max(100).default([]),
}).strict();
const metadataSchema=z.object({sourceVersion:z.string().min(1).max(128),validUntilEpochMs:z.number().int().positive().optional()}).passthrough();

export function ragClearance(roles:readonly string[]):number {
  if(roles.includes('SYSTEM_ADMIN')||roles.includes('SECURITY_ADMIN'))return 10;
  if(roles.includes('AUDIT_ADMIN'))return 8;
  if(roles.includes('BUSINESS_OPERATOR')||roles.includes('APP_DEVELOPER'))return 5;
  return 3;
}
export function assertRagRetrievalAccess(input:{
  scope:TenantScope;principal:RagPrincipal;
  source:{tenantId:string;applicationId:string;state:string;classification:number;acl:unknown};
}):void {
  const {source,scope,principal}=input,acl=aclSchema.parse(source.acl??{});
  if(source.tenantId!==scope.tenantId||source.applicationId!==scope.applicationId||source.state!=='accepted'||
    source.classification>principal.clearance||
    (acl.allowedPrincipals.length>0&&!acl.allowedPrincipals.includes(principal.id))||
    (acl.allowedRoles.length>0&&!acl.allowedRoles.some(role=>principal.roles.includes(role)))) {
    throw new RagRetrievalError('RAG_RETRIEVAL_ACCESS_DENIED');
  }
}
export async function retrieveGuardedRagContext(input:{
  scope:TenantScope;principal:RagPrincipal;requestId:string;traceId:string;bundleId?:string;
  sourceIds:readonly string[];query:string;maximumCandidates:number;minimumTrustLevel:number;
  absoluteDeadlineEpochMs:number;signal:AbortSignal;
}) {
  if(input.absoluteDeadlineEpochMs<=Date.now()||input.absoluteDeadlineEpochMs>Date.now()+60000)throw new RagRetrievalError('RAG_DEADLINE_INVALID');
  const signal=AbortSignal.any([input.signal,AbortSignal.timeout(Math.max(1,input.absoluteDeadlineEpochMs-Date.now()))]);
  const bundle=input.bundleId ? await loadVerifiedPolicyBundle(input.scope,input.bundleId) : await loadRuntimePolicyBundle(input.scope,undefined,input.requestId);
  // ACL and classification filtering precede object-store reads. The caller cannot supply principal claims.
  const rows=await db.select({chunk:ragChunks,source:ragSources,artifact:artifacts}).from(ragChunks)
    .innerJoin(ragSources,and(eq(ragChunks.sourceId,ragSources.id),
      eq(ragChunks.tenantId,ragSources.tenantId),eq(ragChunks.applicationId,ragSources.applicationId)))
    .innerJoin(artifacts,and(eq(ragChunks.artifactId,artifacts.id),
      eq(ragChunks.tenantId,artifacts.tenantId),eq(ragChunks.applicationId,artifacts.applicationId)))
    .where(and(scopePredicate(ragChunks,input.scope),scopePredicate(ragSources,input.scope),
      inArray(ragSources.id,[...input.sourceIds]),eq(ragSources.state,'accepted'),eq(ragChunks.state,'accepted'),
      eq(artifacts.state,'accepted'),eq(artifacts.kind,'RAG_CHUNK'),sql`${artifacts.contentExpiresAt}>now()`,
      lte(ragSources.classification,input.principal.clearance),
      sql`(coalesce(${ragSources.acl}->'allowedPrincipals','[]'::jsonb)='[]'::jsonb OR
        (${ragSources.acl}->'allowedPrincipals') @> ${JSON.stringify([input.principal.id])}::jsonb)`,
      sql`(coalesce(${ragSources.acl}->'allowedRoles','[]'::jsonb)='[]'::jsonb OR
        EXISTS (SELECT 1 FROM jsonb_array_elements_text(${ragSources.acl}->'allowedRoles') AS allowed(role)
          WHERE ${JSON.stringify(input.principal.roles)}::jsonb @> to_jsonb(allowed.role)))`,
    )).orderBy(ragChunks.id).limit(input.maximumCandidates);
  const candidates:RagCandidate[]=[],unavailable:Array<{chunkId:string;code:string}>=[];
  let totalChars=0;
  for(const {source,chunk,artifact} of rows) {
    signal.throwIfAborted();
    assertRagRetrievalAccess({scope:input.scope,principal:input.principal,source});
    const metadata=metadataSchema.safeParse(chunk.metadata);
    if(!metadata.success||(metadata.data.validUntilEpochMs!==undefined&&metadata.data.validUntilEpochMs<=Date.now())){
      unavailable.push({chunkId:chunk.externalChunkId,code:'RAG_SOURCE_VERSION_OR_EXPIRY_INVALID'});continue;
    }
    if (artifact.metadata?.mediaLineage !== undefined) {
      try { await validateMediaRagLineage(db, input.scope, artifact.ownerId, artifact.metadata.mediaLineage); }
      catch { unavailable.push({chunkId:chunk.externalChunkId,code:'RAG_MEDIA_SOURCE_UNAVAILABLE'}); continue; }
    }
    const acl=aclSchema.parse(source.acl??{});
    const text=await readAcceptedTextArtifact(input.scope,chunk.artifactId,131072,['RAG_CHUNK'],signal);
    if(text.length>32768||totalChars+text.length>1000000)throw new RagRetrievalError('RAG_CONTEXT_BUDGET_EXCEEDED');
    if(ragContentHash(text)!==chunk.contentHash)throw new RagRetrievalError('RAG_CONTENT_HASH_MISMATCH');
    totalChars+=text.length;
    candidates.push({...input.scope,sourceId:source.id,chunkId:chunk.externalChunkId,text,contentHash:chunk.contentHash,
      trustLevel:source.trustLevel,classification:source.classification,...acl,state:'accepted',
      sourceVersion:metadata.data.sourceVersion,validUntilEpochMs:metadata.data.validUntilEpochMs,signature:chunk.provenanceSignature});
  }
  const guarded=await guardRagFlow({...input,signal,bundle,candidates});
  const decisions=[guarded.decisions.query,...guarded.decisions.candidates,guarded.decisions.context,guarded.decisions.combination];
  if(decisions.some(decision=>decision.degraded||decision.degradationReasons.length>0||decision.evidenceComplete===false))throw new RagRetrievalError('RAG_DETECTION_COVERAGE_INCOMPLETE');
  signal.throwIfAborted();
  const allowed=['ALLOW','WARN'].includes(guarded.action);
  const acceptedIds=new Set(guarded.acceptedChunkIds);
  const approved=allowed?candidates.filter(candidate=>acceptedIds.has(candidate.chunkId)):[];
  const approvedContext=approved.map(candidate=>({
    sourceId:candidate.sourceId,chunkId:candidate.chunkId,sourceVersion:candidate.sourceVersion!,
    contentHash:candidate.contentHash,text:candidate.text,instructionCapability:'FORBIDDEN' as const,trustLevel:'UNTRUSTED' as const,
  }));
  const sourceReferences=approvedContext.map(({text,...reference})=>{
    const row=rows.find(item=>item.source.id===reference.sourceId&&item.chunk.externalChunkId===reference.chunkId);
    if(!row)throw new RagRetrievalError('RAG_REFERENCE_CHANGED');
    return {...reference,textLength:text.length,chunkRecordId:row.chunk.id,artifactId:row.artifact.id,bindingDigest:ragReferenceDigest(row)};
  });
  const manifest={contractVersion:'1.0',...input.scope,subjectId:input.principal.id,requestId:input.requestId,
    bundleId:bundle.id,principalClaimsHmac:evidenceHmac(canonicalJson(input.principal)),
    contextHmac:evidenceHmac(canonicalJson(approvedContext)),sourceReferences,issuedAt:Date.now(),
    expiresAt:Math.min(input.absoluteDeadlineEpochMs,...approved.map(item=>item.validUntilEpochMs??input.absoluteDeadlineEpochMs))};
  const proof={manifest,...signPayload('gateway-rag-context-v1',manifest)};
  // Recheck mutable ACL, object lifetime and version under short read locks before recording the proof.
  await db.transaction(async transaction=>{
    if(rows.length){
      const current=await transaction.select({chunk:ragChunks,source:ragSources,artifact:artifacts}).from(ragChunks)
        .innerJoin(ragSources,and(eq(ragChunks.sourceId,ragSources.id),eq(ragChunks.tenantId,ragSources.tenantId),eq(ragChunks.applicationId,ragSources.applicationId)))
        .innerJoin(artifacts,and(eq(ragChunks.artifactId,artifacts.id),eq(ragChunks.tenantId,artifacts.tenantId),eq(ragChunks.applicationId,artifacts.applicationId)))
        .where(and(scopePredicate(ragChunks,input.scope),inArray(ragChunks.id,rows.map(row=>row.chunk.id)))).for('share');
      if(current.length!==rows.length)throw new RagRetrievalError('RAG_REFERENCE_CHANGED');
      for(const row of current){
        if (acceptedIds.has(row.chunk.externalChunkId) && row.artifact.metadata?.mediaLineage !== undefined) await validateMediaRagLineage(transaction, input.scope, row.artifact.ownerId, row.artifact.metadata.mediaLineage);
        const original=rows.find(item=>item.chunk.id===row.chunk.id);
        if(!original||ragReferenceBinding(row)!==ragReferenceBinding(original)||row.artifact.contentExpiresAt<=new Date())throw new RagRetrievalError('RAG_REFERENCE_CHANGED');
        const latestMetadata=metadataSchema.safeParse(row.chunk.metadata);
        if(acceptedIds.has(row.chunk.externalChunkId)&&(!latestMetadata.success||(latestMetadata.data.validUntilEpochMs!==undefined&&latestMetadata.data.validUntilEpochMs<=Date.now())))throw new RagRetrievalError('RAG_SOURCE_EXPIRED');
      }
    }
    signal.throwIfAborted();
    await transaction.insert(ragRetrievalAudits).values({...input.scope,principalId:input.principal.id,traceId:input.traceId,
    queryHash:evidenceHmac(input.query),candidateCount:rows.length,acceptedCount:approved.length,
    rejected:[...unavailable,...guarded.rejected],tainted:guarded.tainted||unavailable.length>0,
    retrievalProof:proof,requestId:input.requestId,bundleId:bundle.id});
  });
  return {action:approved.length===0&&allowed?'BLOCK':guarded.action,status:approved.length===0?'NO_APPROVED_CONTEXT':'CONTEXT_VERIFIED',approvedContext,proof,rejected:[...unavailable,...guarded.rejected],
    retrievedCount:rows.length,tainted:guarded.tainted||unavailable.length>0,decisions:guarded.decisions};
}
