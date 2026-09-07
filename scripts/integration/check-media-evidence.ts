import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {and,eq} from 'drizzle-orm';
import type {ArchiveObjectStore,StoredArchiveObject} from '../../src/lib/conversation-archive/object-store';
class MemoryObjects implements ArchiveObjectStore{
 readonly objects=new Map<string,{bytes:Uint8Array;ref:StoredArchiveObject}>();failAfterWrite=false;failRead=false;
 async putImmutable(key:string,bytes:Uint8Array){let saved=this.objects.get(key);const sha=createHash('sha256').update(bytes).digest('hex');if(!saved){saved={bytes:new Uint8Array(bytes),ref:{objectVersion:randomUUID(),ciphertextSha256:sha,sizeBytes:bytes.length}};this.objects.set(key,saved);}assert.equal(saved.ref.ciphertextSha256,sha);if(this.failAfterWrite){this.failAfterWrite=false;throw new Error('SYNTHETIC_ACK_LOSS');}return saved.ref;}
 async readVersion(key:string,ref:StoredArchiveObject){if(this.failRead)throw new Error('SYNTHETIC_STORAGE_UNAVAILABLE');const saved=this.objects.get(key);assert.ok(saved);assert.equal(saved.ref.objectVersion,ref.objectVersion);return new Uint8Array(saved.bytes);}
 async deleteVersion(key:string,version:string){const saved=this.objects.get(key);if(saved)assert.equal(saved.ref.objectVersion,version);this.objects.delete(key);}
}
async function main(){
 const base='.artifact-build/upgrade-implementation-20260907/environment',environment=JSON.parse(readFileSync(base+'/environment.json','utf8')) as Record<string,string>,url=new URL(environment.PGDATABASE_URL);
 if(url.hostname!=='127.0.0.1'||url.port!=='55447'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_DATABASE_REQUIRED');Object.assign(process.env,environment);process.env.GATEWAY_ARCHIVE_MODE='STRICT_OBJECT';
 const fixture=JSON.parse(readFileSync(base+'/fixture.json','utf8')) as {tenantId:string;applicationId:string},scope={tenantId:fixture.tenantId,applicationId:fixture.applicationId};
 const client=new pg.Client({connectionString:url.toString(),ssl:false});await client.connect();try{await client.query(readFileSync('drizzle/0063_media_evidence_snapshots.sql','utf8'));await client.query(readFileSync('drizzle/0064_feedback_candidate_exports.sql','utf8'));}catch(error){await client.end();throw error;}
 const [{db,closeDatabaseConnection},s,service,{makeEvidenceView},{completeGuardJob},{requestEvidenceAccess,reviewContentAccessRequest},{projectSecurityAlerts}]=await Promise.all([import('../../src/storage/database/shared/db'),import('../../src/storage/database/shared/schema'),import('../../src/lib/evidence/media-snapshots'),import('../../src/lib/evidence/media-views'),import('../../src/lib/guard-jobs/service'),import('../../src/lib/incidents/content-access'),import('../../src/lib/security-alerts/service')]);
 const [sourceTemplate]=await db.select().from(s.artifacts).where(and(eq(s.artifacts.tenantId,scope.tenantId),eq(s.artifacts.applicationId,scope.applicationId))).limit(1),[jobTemplate]=await db.select().from(s.guardJobs).where(and(eq(s.guardJobs.tenantId,scope.tenantId),eq(s.guardJobs.applicationId,scope.applicationId))).limit(1);assert.ok(sourceTemplate);assert.ok(jobTemplate);
 const store=new MemoryObjects(),results:string[]=[],jobId=randomUUID(),artifactId=randomUUID(),owner='media-evidence-owner',sha=createHash('sha256').update('synthetic source').digest('hex'),text='正常😀敏感词',now=new Date();
 const view=makeEvidenceView({artifactId,sourceDigest:sha,text,source:'image_ocr',contentPath:'/views/rotate_90',viewId:'rotate_90',page:1,region:[0,0.5,0.5,1]});
 const result={action:'BLOCK',evidence:[{evidenceRef:'synthetic-'+jobId,riskType:'test.media.'+jobId,score:1,action:'BLOCK',reasonCode:'SYNTHETIC_MEDIA_EVIDENCE',locationState:'VERIFIED',locations:[{...view,text:undefined,source:undefined,textStart:4,textEnd:7,textLength:7}]}]};
 async function test(name:string,run:()=>Promise<void>){await run();results.push(name);console.log('PASS '+name);}
 try{
  await db.insert(s.artifacts).values({...sourceTemplate,...scope,id:artifactId,ownerId:owner,state:'accepted',kind:'IMAGE',declaredSize:16,verifiedSize:16,declaredSha256:sha,verifiedSha256:sha,objectPrefix:'synthetic/'+artifactId,declaredMediaType:'image/png',detectedMediaType:'image/png',idempotencyKey:artifactId,requestHash:sha,contentExpiresAt:new Date(now.getTime()+3600000)});
  const [job]=await db.insert(s.guardJobs).values({...jobTemplate,...scope,id:jobId,ownerId:owner,artifactId,contextArtifactId:null,jobType:'document_image',status:'running',result:null,executionBinding:null,idempotencyKey:jobId,requestHash:sha,createdAt:new Date(now.getTime()-180*86400000+120000)}).returning();
  const id=service.mediaEvidenceId(scope,jobId);
  await test('job terminal result, private encrypted evidence and alert record commit atomically',async()=>{
   await assert.rejects(completeGuardJob(job,result,{views:[{...view,artifactId:randomUUID()}]}),/SOURCE_NOT_IN_JOB/);
   const [stillRunning]=await db.select().from(s.guardJobs).where(eq(s.guardJobs.id,jobId));assert.equal(stillRunning.status,'running');
   await completeGuardJob(job,result,{views:[view],mappings:[{viewId:'rotate_90',matrix:[0,1,0,-1,0,1]}]});
   const [saved]=await db.select().from(s.mediaEvidenceSnapshots).where(eq(s.mediaEvidenceSnapshots.id,id));assert.equal(saved.state,'PENDING');assert.ok(saved.spool);assert.ok(!JSON.stringify(saved.spool).includes(text));
   const [completed]=await db.select().from(s.guardJobs).where(eq(s.guardJobs.id,jobId));assert.ok(!JSON.stringify(completed.result).includes(text));assert.equal(completed.status,'completed');
   await assert.rejects(completeGuardJob(job,{...result,action:'ALLOW'},{views:[{...view,text:'changed'}]}));
   await assert.rejects(db.update(s.mediaEvidenceSnapshots).set({contentHmac:'f'.repeat(64)}).where(eq(s.mediaEvidenceSnapshots.id,id)));
  });
  await test('upload acknowledgement loss retries the identical object before clearing encrypted spool',async()=>{
   store.failAfterWrite=true;await assert.rejects(service.publishMediaEvidence(scope,id,store));assert.equal(store.objects.size,1);
   await service.publishMediaEvidence(scope,id,store);const [saved]=await db.select().from(s.mediaEvidenceSnapshots).where(eq(s.mediaEvidenceSnapshots.id,id));assert.equal(saved.state,'READY');assert.equal(saved.spool,null);
   assert.equal((await service.readMediaEvidence(scope,id,store)).content.views[0].text,text);
  });
  let grantId='';
  await test('independent scoped grant survives read failures and highlights only the recorded text version',async()=>{
   await projectSecurityAlerts();
   const requester={...scope,principalId:'media-evidence-requester'},grant=await requestEvidenceAccess(requester,id,{purpose:'INCIDENT_INVESTIGATION',reason:'Synthetic media evidence version validation.'},'MEDIA_EVIDENCE');grantId=grant.id;
   await assert.rejects(reviewContentAccessRequest(requester,grant.id,{action:'approve',reason:'self review is not allowed'}),/requester cannot review/);
   await client.query('BEGIN');await client.query('select id from media_evidence_snapshots where id=$1 for update',[id]);
   let approvalSettled=false;const approval=reviewContentAccessRequest({...scope,principalId:'media-evidence-reviewer'},grant.id,{action:'approve',reason:'Independent synthetic evidence approval.'}).finally(()=>{approvalSettled=true;});
   try{await new Promise(resolve=>setTimeout(resolve,100));assert.equal(approvalSettled,false,'approval must wait for the retention identity lock');}finally{await client.query('ROLLBACK');await approval;}

   assert.equal(await service.deleteExpiredMediaEvidence(scope,id,store,new Date(now.getTime()+180000)),false);
   store.failRead=true;await assert.rejects(service.consumeMediaEvidence(requester,id,grant.id,store));store.failRead=false;
   const [unconsumed]=await db.select().from(s.contentAccessRequests).where(eq(s.contentAccessRequests.id,grant.id));assert.equal(unconsumed.usedAt,null);
   await assert.rejects(service.consumeMediaEvidence({...requester,applicationId:randomUUID()},id,grant.id,store));
   const consumed=await service.consumeMediaEvidence(requester,id,grant.id,store);assert.equal(consumed.highlightViews[0]?.parts.find(part=>part.evidenceIds.length)?.text,'敏感词');
   await assert.rejects(service.consumeMediaEvidence(requester,id,grant.id,store));
  });
  await test('triaged feedback exports a redacted unsigned candidate with an atomic one-time grant and audit ledger',async()=>{
   const {submitAlertFeedback,reviewAlertFeedback}=await import('../../src/lib/security-alerts/feedback');const {createFeedbackCandidate,listFeedbackCandidateSources}=await import('../../src/lib/security-alerts/feedback-candidate');
   const [alert]=await db.select().from(s.securityAlerts).where(eq(s.securityAlerts.jobId,jobId));assert.ok(alert);
   const feedback=await submitAlertFeedback({...scope,principalId:'feedback-author'},alert.id,{classification:'FALSE_POSITIVE',expectedAction:'ALLOW',reason:'Synthetic normal context should remain a reviewed candidate.'});
   const requester={...scope,principalId:'candidate-creator'},grant=await requestEvidenceAccess(requester,id,{purpose:'FALSE_POSITIVE_APPEAL',reason:'Prepare a synthetic reviewed-feedback test candidate.'},'MEDIA_EVIDENCE');
   await assert.rejects(requestEvidenceAccess(requester,id,{purpose:'INCIDENT_INVESTIGATION',reason:'A different purpose must not reuse the pending grant.'},'MEDIA_EVIDENCE'),/another purpose/);
   assert.ok((await listFeedbackCandidateSources(requester,alert.id)).items.some(item=>item.id===id));
   await reviewContentAccessRequest({...scope,principalId:'candidate-source-reviewer'},grant.id,{action:'approve',reason:'Approve internal synthetic candidate preparation.'});
   const input={feedbackId:feedback.id,resourceType:'MEDIA_EVIDENCE' as const,resourceId:id,accessRequestId:grant.id,selector:'MATCHED_EVIDENCE',licenseRef:'SYNTHETIC_ENGINEERING_FIXTURE',origin:'synthetic' as const};
   await assert.rejects(createFeedbackCandidate(requester,alert.id,input,store),/TRIAGE_REQUIRED/);
   await reviewAlertFeedback({...scope,principalId:'feedback-reviewer'},alert.id,{feedbackId:feedback.id,decision:'ACCEPT',reason:'Confirm synthetic feedback for candidate preparation only.'});
   await assert.rejects(createFeedbackCandidate(requester,alert.id,{...input,selector:'/constructor'},store),/SELECTOR_INVALID/);
   const [unused]=await db.select().from(s.contentAccessRequests).where(eq(s.contentAccessRequests.id,grant.id));assert.equal(unused.usedAt,null);
   await db.update(s.badcaseFeedback).set({expectedAction:'BLOCK'}).where(eq(s.badcaseFeedback.id,feedback.id));await assert.rejects(createFeedbackCandidate(requester,alert.id,input,store),/REVIEW_SOURCE_CHANGED/);await db.update(s.badcaseFeedback).set({expectedAction:'ALLOW'}).where(eq(s.badcaseFeedback.id,feedback.id));
   const candidate=await createFeedbackCandidate(requester,alert.id,input,store);assert.equal(candidate.workbench.qualityStatus,'INSUFFICIENT_EVIDENCE');assert.equal(candidate.workbench.records[0].case.annotationStatus,'needs_review');assert.deepEqual(candidate.workbench.records[0].reviews,[]);assert.equal(candidate.workbench.records[0].case.authorizedExternalUse,false);assert.deepEqual(candidate.workbench.records[0].case.expectedRiskIds,[]);
   const [ledger]=await db.select().from(s.feedbackCandidateExports).where(eq(s.feedbackCandidateExports.id,candidate.candidateId));assert.equal(ledger.grantId,grant.id);assert.ok(!JSON.stringify(ledger).includes(text));
   await assert.rejects(createFeedbackCandidate(requester,alert.id,input,store));await assert.rejects(db.update(s.feedbackCandidateExports).set({candidateDigest:'f'.repeat(64)}).where(eq(s.feedbackCandidateExports.id,ledger.id)));
  });
  await test('holds block deletion and expiration leaves an immutable object-version proof',async()=>{
   await service.setMediaEvidenceHold({...scope,principalId:'media-evidence-reviewer'},id,new Date(now.getTime()+86400000));
   await assert.rejects(service.setMediaEvidenceHold({...scope,principalId:'media-evidence-reviewer'},id,new Date(now.getTime()+3600000)),/CANNOT_SHORTEN/);
   assert.equal(await service.deleteExpiredMediaEvidence(scope,id,store,new Date(now.getTime()+180000)),false);
   assert.equal(await service.deleteExpiredMediaEvidence(scope,id,store,new Date(now.getTime()+2*86400000)),true);
   const [saved]=await db.select().from(s.mediaEvidenceSnapshots).where(eq(s.mediaEvidenceSnapshots.id,id));assert.equal(saved.state,'DELETED');assert.equal(saved.deletionProof?.backupStatus,'PENDING_EXTERNAL');assert.equal(store.objects.size,0);
   await assert.rejects(service.readMediaEvidence(scope,id,store));await assert.rejects(db.delete(s.mediaEvidenceSnapshots).where(eq(s.mediaEvidenceSnapshots.id,id)));
   assert.ok(grantId);
  });
 }finally{await closeDatabaseConnection();await client.end();writeFileSync('.artifact-build/v11-continuation-20260908/media-evidence-db.json',JSON.stringify({results,syntheticDataOnly:true,isolatedDatabase:true},null,2));}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'MEDIA_EVIDENCE_TEST_FAILED');process.exitCode=1;});
