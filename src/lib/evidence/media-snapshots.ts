import {assertReviewBindings,highlightReviewEvidence} from './review-evidence';
import { enqueueLayeredEvidence, publishEvidenceChunks, readLayeredEvidence, deleteEvidenceChunks, layeredManifestSchema, MAX_MEDIA_EVIDENCE_BYTES } from './layered-media';
import {intakeBindingSchema} from '@/lib/guard-jobs/intake-binding';
import { nativeJobBindingSchema } from '@/lib/guard-jobs/native-binding';
import { enqueueDecisionRecord } from '@/lib/security-alerts/service';
import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { artifacts, guardJobs, mediaEvidenceSnapshots, contentAccessRequests, securityAlerts } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope, type TenantContext } from '@/lib/tenancy';
import { evidenceSnapshotSchema, mediaEvidenceMetadataSchema, type EvidenceView,type ReviewEvidence } from '@/contracts/http/media-evidence';
import { sealReceipt, openReceipt, archiveContentHmac } from '@/lib/gateway-runtime/security';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import { archiveObjectStore, type ArchiveObjectStore } from '@/lib/conversation-archive/object-store';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import { uniqueEvidenceViews, textVersion, highlightMediaViews } from './media-views';
import type { SecretEnvelope } from '@/lib/secrets/types';
type Transaction=Parameters<Parameters<typeof db.transaction>[0]>[0];
type Snapshot=typeof mediaEvidenceSnapshots.$inferSelect;
export interface PrivateMediaEvidence {views:readonly EvidenceView[];mappings?:readonly Record<string,unknown>[];reviewEvidence?:readonly ReviewEvidence[]}
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const normalize=(value:unknown)=>canonicalJson(JSON.parse(JSON.stringify(value)));
export const mediaEvidenceId=(scope:TenantScope,jobId:string)=>digest(canonicalJson(['media-evidence-1',scope.tenantId,scope.applicationId,jobId]));
const active=(row:Snapshot,now=new Date())=>row.state==='READY'&&(row.expiresAt>now||Boolean(row.holdUntil&&row.holdUntil>now));
const fail=(code:string):never=>{throw new Error(code);};
export function mediaEvidenceMetadata(row:Snapshot){return mediaEvidenceMetadataSchema.parse({id:row.id,jobId:row.jobId,state:row.state,sourceDigest:row.contentHmac,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),holdUntil:row.holdUntil?.toISOString()??null,errorCode:row.errorCode});}
export async function enqueueMediaEvidenceSnapshot(tx:Transaction,job:typeof guardJobs.$inferSelect,input:PrivateMediaEvidence){
 const scope={tenantId:job.tenantId,applicationId:job.applicationId},id=mediaEvidenceId(scope,job.id);
 const payload=evidenceSnapshotSchema.parse({version:'media-evidence-1',jobId:job.id,bundleId:job.bundleId,views:uniqueEvidenceViews(input.views),mappings:input.mappings??[],...(input.reviewEvidence?.length?{reviewEvidence:input.reviewEvidence}:{})});
 assertReviewBindings(payload.views,payload.reviewEvidence??[]);
 const allowedSources=new Map<string,string|null>([[job.artifactId,null],...(job.contextArtifactId?[[job.contextArtifactId,null] as [string,null]]:[])]);
 if(job.jobType==='native_joint'){const binding=nativeJobBindingSchema.parse(job.executionBinding);allowedSources.clear();allowedSources.set(binding.contextArtifactId,binding.contextSha256);for(const source of binding.artifacts)allowedSources.set(source.id,source.sha256);}
 if(job.jobType==='intake'){const binding=intakeBindingSchema.parse(job.executionBinding);allowedSources.clear();for(const source of binding.artifacts)allowedSources.set(source.id,source.sha256);}
 const sourceDigests=new Map<string,string>();
 for(const view of payload.views){if(!allowedSources.has(view.artifactId)||allowedSources.get(view.artifactId)&&allowedSources.get(view.artifactId)!==view.sourceDigest)fail('MEDIA_EVIDENCE_SOURCE_NOT_IN_JOB');if(textVersion(view.text)!==view.contentVersion)fail('MEDIA_EVIDENCE_TEXT_VERSION_CHANGED');const prior=sourceDigests.get(view.artifactId);if(prior&&prior!==view.sourceDigest)fail('MEDIA_EVIDENCE_SOURCE_CONFLICT');sourceDigests.set(view.artifactId,view.sourceDigest);}
 if(sourceDigests.size>9)fail('MEDIA_EVIDENCE_SOURCE_BUDGET');
 for(const [artifactId,sha] of sourceDigests){const [source]=await tx.select().from(artifacts).where(and(scopePredicate(artifacts,scope),eq(artifacts.id,artifactId),eq(artifacts.ownerId,job.ownerId),eq(artifacts.state,'accepted'))).for('share');if(!source||source.verifiedSha256!==sha||source.contentExpiresAt<=new Date())fail('MEDIA_EVIDENCE_SOURCE_CHANGED');}
 const text=normalize(payload);if(Buffer.byteLength(text)>MAX_MEDIA_EVIDENCE_BYTES)fail('MEDIA_EVIDENCE_BUDGET_EXCEEDED');
 const [existing]=await tx.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id)));
 if(existing){if(existing.contentHmac!==archiveContentHmac(text,existing.keyIds[0]))fail('MEDIA_EVIDENCE_IDENTITY_CONFLICT');return mediaEvidenceMetadata(existing);}
 const storedPayload=Buffer.byteLength(text)>1024*1024?await enqueueLayeredEvidence(tx,scope,id,payload):payload;
 const spool=sealReceipt(storedPayload,'media-evidence:'+id),encoded=canonicalJson(spool);
 const [row]=await tx.insert(mediaEvidenceSnapshots).values({...scope,id,jobId:job.id,contentHmac:archiveContentHmac(text,spool[0].keyId),ciphertextSha256:digest(encoded),sizeBytes:Buffer.byteLength(encoded),
 objectKey:`archives/${scope.tenantId}/${scope.applicationId}/${id}.json`,keyIds:[...new Set(spool.map(item=>item.keyId))],spool,expiresAt:new Date(job.createdAt.getTime()+180*86400000)}).returning();return mediaEvidenceMetadata(row);
}
async function readRow(scope:TenantScope,id:string){const [row]=await db.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id))).limit(1);if(!row)fail('MEDIA_EVIDENCE_NOT_FOUND');return row;}
export async function publishMediaEvidence(scope:TenantScope,id:string,store:ArchiveObjectStore=archiveObjectStore()){
 const row=await readRow(scope,id);if(row.state==='READY')return mediaEvidenceMetadata(row);if(!['PENDING','OBJECT_WRITTEN'].includes(row.state)||!row.spool)fail('MEDIA_EVIDENCE_STATE_INVALID');
 const bytes=Buffer.from(canonicalJson(row.spool));
 try{
  await publishEvidenceChunks(scope,id,store);
  if(bytes.length!==row.sizeBytes||digest(bytes)!==row.ciphertextSha256)fail('MEDIA_EVIDENCE_SPOOL_CORRUPT');
  const reference=row.objectVersion?{objectVersion:row.objectVersion,sizeBytes:row.sizeBytes,ciphertextSha256:row.ciphertextSha256}:await store.putImmutable(row.objectKey,bytes);
  const observed=await store.readVersion(row.objectKey,reference);try{if(observed.length!==row.sizeBytes||digest(observed)!==row.ciphertextSha256)fail('MEDIA_EVIDENCE_STORED_VERSION_CHANGED');}finally{observed.fill(0);}
  await db.transaction(async tx=>{const [current]=await tx.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id))).for('update');if(!current||current.objectVersion&&current.objectVersion!==reference.objectVersion)fail('MEDIA_EVIDENCE_VERSION_CONFLICT');if(current.state==='PENDING')await tx.update(mediaEvidenceSnapshots).set({state:'OBJECT_WRITTEN',objectVersion:reference.objectVersion,errorCode:null}).where(eq(mediaEvidenceSnapshots.id,id));});
  await db.update(mediaEvidenceSnapshots).set({state:'READY',spool:null,verifiedAt:new Date(),errorCode:null}).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id),eq(mediaEvidenceSnapshots.state,'OBJECT_WRITTEN'),eq(mediaEvidenceSnapshots.objectVersion,reference.objectVersion)));
  return mediaEvidenceMetadata(await readRow(scope,id));
 }catch(error:unknown){await db.update(mediaEvidenceSnapshots).set({attempt:sql`${mediaEvidenceSnapshots.attempt}+1`,errorCode:'MEDIA_EVIDENCE_PERSISTENCE_FAILED',retryAt:new Date(Date.now()+Math.min(300000,1000*2**Math.min(row.attempt,8)))}).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id),inArray(mediaEvidenceSnapshots.state,['PENDING','OBJECT_WRITTEN'])));throw error;}finally{bytes.fill(0);}
}
export async function readMediaEvidence(scope:TenantScope,id:string,store:ArchiveObjectStore=archiveObjectStore()){
 const row=await readRow(scope,id);if(!active(row)||!row.objectVersion)fail('MEDIA_EVIDENCE_NOT_AVAILABLE');
 const bytes=await store.readVersion(row.objectKey,{objectVersion:row.objectVersion!,sizeBytes:row.sizeBytes,ciphertextSha256:row.ciphertextSha256});
 try{if(bytes.length!==row.sizeBytes||digest(bytes)!==row.ciphertextSha256)fail('MEDIA_EVIDENCE_STORED_VERSION_CHANGED');
  const envelopes=JSON.parse(Buffer.from(bytes).toString('utf8')) as SecretEnvelope[];
  const opened=openReceipt(envelopes,'media-evidence:'+id);
  const layered=layeredManifestSchema.safeParse(opened);
  const content=layered.success?await readLayeredEvidence(scope,id,layered.data,store):evidenceSnapshotSchema.parse(opened);
  if(content.jobId!==row.jobId||archiveContentHmac(normalize(content),row.keyIds[0])!==row.contentHmac)fail('MEDIA_EVIDENCE_INTEGRITY_FAILED');
  for(const view of content.views)if(textVersion(view.text)!==view.contentVersion)fail('MEDIA_EVIDENCE_TEXT_VERSION_CHANGED');
  assertReviewBindings(content.views,content.reviewEvidence??[]);
  return {row,content};
 }finally{bytes.fill(0);}
}
export async function consumeMediaEvidence(scope:TenantContext,id:string,grantId:string,store?:ArchiveObjectStore,afterConsume?:(tx:Transaction,payload:{answerEvidence:string;sourceDigest:string;highlightViews:ReturnType<typeof highlightMediaViews>})=>Promise<void>){
 const predicate=and(scopePredicate(contentAccessRequests,scope),eq(contentAccessRequests.id,grantId),eq(contentAccessRequests.resourceType,'MEDIA_EVIDENCE'),eq(contentAccessRequests.resourceId,id),eq(contentAccessRequests.requesterId,scope.principalId),eq(contentAccessRequests.status,'approved'),isNull(contentAccessRequests.usedAt),gt(contentAccessRequests.expiresAt,new Date()));
 const [grant]=await db.select().from(contentAccessRequests).where(predicate).limit(1);if(!grant)fail('MEDIA_EVIDENCE_GRANT_UNAVAILABLE');
 const before=await readRow(scope,id);if(!active(before)||before.contentHmac!==grant.sourceDigest)fail('MEDIA_EVIDENCE_GRANT_CHANGED');
 const {row,content}=await readMediaEvidence(scope,id,store);
 const alerts=await db.select({evidence:securityAlerts.evidence}).from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.jobId,row.jobId))).limit(1000);
 const highlightViews=highlightMediaViews(content.views,alerts),reviewHighlights=highlightReviewEvidence(content.views,content.reviewEvidence??[]);
 return db.transaction(async tx=>{const [current]=await tx.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id))).for('share');const [access]=await tx.select().from(contentAccessRequests).where(predicate).for('update');const now=new Date();if(!current||!active(current,now)||current.contentHmac!==grant.sourceDigest||!access||!access.expiresAt||access.expiresAt<=now||access.sourceDigest!==current.contentHmac)fail('MEDIA_EVIDENCE_GRANT_CHANGED');
  await tx.update(contentAccessRequests).set({usedAt:now}).where(eq(contentAccessRequests.id,grantId));const payload={incidentId:id,accessRequestId:grantId,sourceDigest:current.contentHmac,expiresAt:access.expiresAt!.toISOString(),consumedAt:now.toISOString(),answerEvidence:JSON.stringify(content,null,2),highlightViews,reviewHighlights};await afterConsume?.(tx,payload);return payload;});
}
export async function listJobMediaEvidence(scope:TenantScope,jobId:string){const rows=await db.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.jobId,jobId))).limit(1);return rows.map(mediaEvidenceMetadata);}
export async function setMediaEvidenceHold(scope:TenantContext,id:string,until:Date){
 if(!Number.isFinite(until.getTime())||until<=new Date())fail('MEDIA_EVIDENCE_HOLD_INVALID');
 return db.transaction(async tx=>{const [row]=await tx.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id))).for('update');if(!row||['DELETE_PENDING','DELETED'].includes(row.state))fail('MEDIA_EVIDENCE_HOLD_UNAVAILABLE');if(row.holdUntil&&row.holdUntil>until)fail('MEDIA_EVIDENCE_HOLD_CANNOT_SHORTEN');await tx.update(mediaEvidenceSnapshots).set({holdUntil:until}).where(eq(mediaEvidenceSnapshots.id,id));await appendAuditEventInTransaction(tx,{...scope,event:'media.evidence.hold',outcome:'ALLOWED',status:200,requestId:id,traceId:row.jobId,method:'INTERNAL',path:'/media-evidence/hold',queryString:'until='+until.toISOString(),latencyMs:0});});
}
export async function deleteExpiredMediaEvidence(scope:TenantScope,id:string,store:ArchiveObjectStore=archiveObjectStore(),now=new Date()){
 const row=await db.transaction(async tx=>{const [current]=await tx.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id))).for('update');if(!current||!['READY','DELETE_PENDING'].includes(current.state)||current.expiresAt>now||current.holdUntil&&current.holdUntil>now)return null;
  const [grant]=await tx.select({id:contentAccessRequests.id}).from(contentAccessRequests).where(and(scopePredicate(contentAccessRequests,scope),or(and(eq(contentAccessRequests.resourceType,'MEDIA_EVIDENCE'),eq(contentAccessRequests.resourceId,id)),and(eq(contentAccessRequests.resourceType,'MEDIA_ORIGINAL'),sql`${contentAccessRequests.resourceId} like ${id+':%'}`)),eq(contentAccessRequests.status,'approved'),isNull(contentAccessRequests.usedAt),gt(contentAccessRequests.expiresAt,now))).limit(1);if(grant)return null;
  if(current.state==='READY')await tx.update(mediaEvidenceSnapshots).set({state:'DELETE_PENDING'}).where(eq(mediaEvidenceSnapshots.id,id));return current;});
 if(!row||!row.objectVersion)return false;
 const deletedChunks=await deleteEvidenceChunks(scope,id,store);
 await store.deleteVersion(row.objectKey,row.objectVersion);
 await db.transaction(async tx=>{const [current]=await tx.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,id))).for('update');if(!current||current.state==='DELETED')return;if(current.state!=='DELETE_PENDING')fail('MEDIA_EVIDENCE_DELETE_STATE_INVALID');
  const proof={version:'media-evidence-delete-1',id,objectVersion:row.objectVersion,ciphertextSha256:row.ciphertextSha256,deletedAt:now.toISOString(),backupStatus:'PENDING_EXTERNAL',chunks:deletedChunks};
  await appendAuditEventInTransaction(tx,{...scope,event:'media.evidence.deleted',outcome:'ALLOWED',status:200,requestId:id,traceId:row.jobId,method:'INTERNAL',path:'/media-evidence/retention',queryString:'proofDigest='+digest(canonicalJson(proof)),latencyMs:0});
  await tx.update(mediaEvidenceSnapshots).set({state:'DELETED',deletedAt:now,deletionProof:proof}).where(eq(mediaEvidenceSnapshots.id,id));});return true;
}
export async function maintainMediaEvidence(maximum=5,store?:ArchiveObjectStore){
 if(!Number.isInteger(maximum)||maximum<1||maximum>100)fail('MEDIA_EVIDENCE_MAINTENANCE_LIMIT');
 const now=new Date(),stale=new Date(now.getTime()-86400000),rows=await db.select().from(mediaEvidenceSnapshots).where(and(lte(mediaEvidenceSnapshots.retryAt,now),or(
  inArray(mediaEvidenceSnapshots.state,['PENDING','OBJECT_WRITTEN','DELETE_PENDING']),
  and(eq(mediaEvidenceSnapshots.state,'READY'),or(lte(mediaEvidenceSnapshots.expiresAt,now),isNull(mediaEvidenceSnapshots.verifiedAt),lte(mediaEvidenceSnapshots.verifiedAt,stale)))
 ))).orderBy(asc(mediaEvidenceSnapshots.retryAt),asc(mediaEvidenceSnapshots.id)).limit(maximum);
 for(const row of rows){try{
  if(['PENDING','OBJECT_WRITTEN'].includes(row.state))await publishMediaEvidence(row,row.id,store);
  else if(row.state==='DELETE_PENDING'||row.expiresAt<=now){
   if(!await deleteExpiredMediaEvidence(row,row.id,store,now)){
    const verifyHeld=row.holdUntil&&row.holdUntil>now&&(!row.verifiedAt||row.verifiedAt<=stale);
    if(verifyHeld)await readMediaEvidence(row,row.id,store);
    await db.update(mediaEvidenceSnapshots).set({retryAt:new Date(now.getTime()+60000),...(verifyHeld?{verifiedAt:now,errorCode:null}:{})}).where(and(eq(mediaEvidenceSnapshots.id,row.id),eq(mediaEvidenceSnapshots.state,'READY')));
   }
  }else{
   await readMediaEvidence(row,row.id,store);
   await db.update(mediaEvidenceSnapshots).set({verifiedAt:now,errorCode:null,retryAt:new Date(now.getTime()+86400000)}).where(and(eq(mediaEvidenceSnapshots.id,row.id),eq(mediaEvidenceSnapshots.state,'READY')));
  }
 }catch{
  await db.transaction(async tx=>{const [current]=await tx.select().from(mediaEvidenceSnapshots).where(eq(mediaEvidenceSnapshots.id,row.id)).for('update');if(!current||current.state==='DELETED')return;
   const code='MEDIA_EVIDENCE_STORAGE_UNAVAILABLE';
   if(current.errorCode!==code&&row.errorCode!==code){const [job]=await tx.select({binding:guardJobs.executionBinding}).from(guardJobs).where(and(scopePredicate(guardJobs,row),eq(guardJobs.id,row.jobId))).limit(1);const binding=nativeJobBindingSchema.safeParse(job?.binding),stage=binding.success?binding.data.direction:'INPUT';const sourceId=row.id+':'+now.getTime();await enqueueDecisionRecord(tx,row,{version:'1.0',source:'GUARD_JOB',sourceId,jobId:row.jobId,traceId:'job-trace-'+row.jobId,decisionId:digest(sourceId),stage,action:'REQUIRE_REVIEW',occurredAt:now.toISOString(),coverage:{evidenceReplayAvailable:false},findings:[{riskId:'system.media_evidence_unavailable',category:'SYSTEM_FAILURE',score:0,reasonCode:code,evidence:[]}]});}
   await tx.update(mediaEvidenceSnapshots).set({errorCode:code,retryAt:new Date(now.getTime()+60000)}).where(eq(mediaEvidenceSnapshots.id,row.id));
  });
 }}return rows.length;
}
