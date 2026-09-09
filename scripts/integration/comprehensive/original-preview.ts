import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {eq} from 'drizzle-orm';
import {db,closeDatabaseConnection} from '@/storage/database/shared/db';
import {artifacts,artifactParts,guardJobs,contentAccessRequests,securityAlerts,mediaEvidenceSnapshots} from '@/storage/database/shared/schema';
import {storeVerifiedBytes} from '@/lib/artifacts/server-upload';
import {captureIntakeBinding} from '@/lib/guard-jobs/intake-binding';
import {consumeMediaEvidence,deleteExpiredMediaEvidence,enqueueMediaEvidenceSnapshot,publishMediaEvidence,mediaEvidenceId} from '@/lib/evidence/media-snapshots';
import {makeEvidenceView} from '@/lib/evidence/media-views';
import {consumeOriginalPreview,listOriginalPreviewSources} from '@/lib/evidence/original-preview';
import {readOriginalResource} from '@/lib/content-access/original-resource';
import {requestEvidenceAccess,reviewContentAccessRequest} from '@/lib/incidents/content-access';
import {enqueueDecisionRecord,projectSecurityAlerts} from '@/lib/security-alerts/service';
const out=resolve(process.env.COMPREHENSIVE_RUN_DIR!);
const f=JSON.parse(readFileSync(out+'/fixture.private.json','utf8')) as {tenantId:string;applicationId:string;userId:string;bundleId:string;other:{userId:string};foreign:{tenantId:string;applicationId:string;userId:string}};
const scope={tenantId:f.tenantId,applicationId:f.applicationId},owner={...scope,principalId:f.userId},reviewer={...scope,principalId:f.other.userId},checks:Array<{id:string;status:'PASS'}>=[];
const check=(id:string)=>{checks.push({id,status:'PASS'});console.log(id+' PASS');};
function pdf(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
 ...['SYNTHETIC FIRST PAGE','SYNTHETIC SECOND PAGE'].map(text=>{const stream='BT /F1 16 Tf 30 100 Td ('+text+') Tj ET';return '<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream';})];
 let value='%PDF-1.4\n';const offsets=[0];for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(value));value+=(index+1)+' 0 obj\n'+object+'\nendobj\n';}
 const xref=Buffer.byteLength(value);value+='xref\n0 8\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
 return Buffer.concat([Buffer.from(value),Buffer.alloc(5*1024*1024,32)]);
}
function wav(){const bytes=Buffer.alloc(44+5*1024*1024);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);for(let n=0;n<32000;n++)bytes.writeInt16LE(Math.round(1000*Math.sin(n*440*2*Math.PI/16000)),44+n*2);return bytes;}
async function main(){
 const database=new URL(process.env.DATABASE_URL!);assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'5438');assert.match(database.pathname,/^\/guardllm_integration_full_\d+$/);
 const document=await storeVerifiedBytes({scope,ownerId:f.userId,kind:'DOCUMENT',fileName:'synthetic-two-pages.pdf',mediaType:'application/pdf',bytes:pdf()});
 const audio=await storeVerifiedBytes({scope,ownerId:f.userId,kind:'AUDIO',fileName:'synthetic-tone.wav',mediaType:'audio/wav',bytes:wav()});
 const binding=(await captureIntakeBinding(scope,f.userId,[document.id,audio.id],'SYNTHETIC PREVIEW ACCESS ONLY')).binding;
 const [job]=await db.insert(guardJobs).values({...scope,ownerId:f.userId,artifactId:document.id,bundleId:f.bundleId,jobType:'intake',status:'completed',stage:'completed',progress:100,completedAt:new Date(),idempotencyKey:randomUUID(),requestHash:'a'.repeat(64),executionBinding:binding,result:{engineeringFixture:true,action:'REQUIRE_REVIEW',degraded:true,releaseEligibility:{eligible:false}}}).returning();
 const views=[makeEvidenceView({artifactId:document.id,sourceDigest:document.verifiedSha256!,text:'SYNTHETIC SECOND PAGE',source:'SYNTHETIC_COORDINATE_FIXTURE',viewId:'page-2-original',contentPath:'/pages/2',page:2,region:[.1,.2,.8,.8],textStart:0,textEnd:21,textLength:21}),
 makeEvidenceView({artifactId:audio.id,sourceDigest:audio.verifiedSha256!,text:'SYNTHETIC TONE',source:'SYNTHETIC_COORDINATE_FIXTURE',viewId:'track-0-original',contentPath:'/tracks/0',startMs:500,endMs:1500,textStart:0,textEnd:14,textLength:14})];
 const locations=views.map(({text,source,...location})=>{void text;void source;return location;});
 await db.transaction(async tx=>{
  await enqueueMediaEvidenceSnapshot(tx,job,{views,reviewEvidence:locations.map((location,index)=>({evidenceId:'review-'+index,polarity:index?'COUNTER' as const:'SUPPORT' as const,riskType:'system.preview_fixture',detectorId:'synthetic-review-fixture',modelVersion:'SYNTHETIC_ONLY',decisionRole:index?'CLEARED':'CANDIDATE',reasonCode:'SYNTHETIC_PREVIEW_ONLY',locations:[location]})),mappings:[{artifactId:document.id,viewId:'page-2-original',page:2,mappingVersion:'inverse-image-view-1',basis:'DISPLAY_ORIENTED_SOURCE_PAGE'},
   {artifactId:audio.id,viewId:'track-0-original',mappingVersion:'audio-time-to-source-2',basis:'SOURCE_TIME_MS',sourceStartMs:0,sourceDurationMs:163840,sampleRate:16000,sampleCount:2621440,timeScale:1,mappingAccuracy:'SOURCE_TIME'}]});
  await enqueueDecisionRecord(tx,scope,{version:'1.0',source:'GUARD_JOB',sourceId:job.id,jobId:job.id,traceId:'preview-'+job.id,decisionId:randomUUID(),bundleId:f.bundleId,stage:'INPUT',action:'REQUIRE_REVIEW',occurredAt:new Date().toISOString(),coverage:{engineeringFixture:true,semanticQualification:false},findings:[{riskId:'system.preview_fixture',score:0,reasonCode:'SYNTHETIC_PREVIEW_ONLY',category:'UNDETERMINED',evidence:locations.map((location,index)=>({evidenceId:'preview-'+index,locations:[location],locationState:'VERIFIED'}))}]});
 });
 const snapshotId=mediaEvidenceId(scope,job.id);await publishMediaEvidence(scope,snapshotId);await projectSecurityAlerts();
 const [alert]=await db.select({id:securityAlerts.id}).from(securityAlerts).where(eq(securityAlerts.jobId,job.id));assert.ok(alert);
 const pdfId=snapshotId+':'+document.id+':2',firstId=snapshotId+':'+document.id+':1',audioId=snapshotId+':'+audio.id+':0';
 assert.equal((await listOriginalPreviewSources(scope,snapshotId)).items.length,2);check('SOURCE_LIST_RETURNS_NO_ORIGINAL_BYTES');
 const grant=async(id:string,type:'MEDIA_ORIGINAL'|'MEDIA_EVIDENCE'='MEDIA_ORIGINAL')=>{
  const row=await requestEvidenceAccess(owner,id,{purpose:'INCIDENT_INVESTIGATION',reason:'Synthetic independent original preview verification only'},type);
  await assert.rejects(reviewContentAccessRequest(owner,row.id,{action:'approve',reason:'Self approval must be rejected'}));
  await reviewContentAccessRequest(reviewer,row.id,{action:'approve',reason:'Independent synthetic engineering review only'});return row.id;
 };
 const textGrant=await grant(snapshotId,'MEDIA_EVIDENCE');
 await assert.rejects(consumeOriginalPreview(owner,pdfId,textGrant),/GRANT_UNAVAILABLE/);check('DERIVED_TEXT_GRANT_CANNOT_READ_ORIGINAL');
 const reviewed=await consumeMediaEvidence(owner,snapshotId,textGrant);assert.deepEqual(reviewed.reviewHighlights.map(item=>item.polarity),['SUPPORT','COUNTER']);assert.equal(reviewed.reviewHighlights[1].parts.find(item=>item.evidenceIds.length)?.text,views[1].text);check('SUPPORT_AND_COUNTER_EVIDENCE_ENCRYPTED_REPLAY');
 await assert.rejects(db.insert(contentAccessRequests).values({...scope,resourceType:'MEDIA_ORIGINAL',resourceId:snapshotId+':'+randomUUID()+':2',sourceDigest:'a'.repeat(64),requesterId:f.userId,purpose:'INCIDENT_INVESTIGATION',reason:'Synthetic invalid original scope must be rejected'}));check('DATABASE_TRIGGER_REJECTS_UNBOUND_SOURCE');
 const approved=await grant(pdfId);
 await assert.rejects(consumeOriginalPreview(reviewer,pdfId,approved),/GRANT_UNAVAILABLE/);
 await assert.rejects(consumeOriginalPreview({...f.foreign,principalId:f.foreign.userId},pdfId,approved),/GRANT_UNAVAILABLE/);
 await assert.rejects(consumeOriginalPreview(owner,firstId,approved),/GRANT_UNAVAILABLE/);check('REQUESTER_TENANT_AND_PAGE_BOUND');
 const page=await consumeOriginalPreview(owner,pdfId,approved);assert.equal(page.originalPreview.page,2);assert.equal(page.originalPreview.totalPages,2);assert.equal(page.originalPreview.media.annotations?.length,1);assert.ok(page.originalPreview.toolchainDigest);assert.equal(createHash('sha256').update(Buffer.from(page.originalPreview.media.dataBase64,'base64')).digest('hex'),page.originalPreview.outputSha256);
 await assert.rejects(consumeOriginalPreview(owner,pdfId,approved),/GRANT_UNAVAILABLE/);check('LARGE_PDF_REAL_RASTER_AND_EXACT_PAGE_ONCE');
 const audioGrant=await grant(audioId),audioResult=await consumeOriginalPreview(owner,audioId,audioGrant);assert.equal(audioResult.originalPreview.sourceSha256,audio.verifiedSha256);assert.deepEqual(audioResult.originalPreview.media.annotations?.map(item=>[item.startMs,item.endMs]),[[500,1500]]);assert.ok(audio.verifiedSize!>4*1024*1024);check('ORIGINAL_AUDIO_OVER_FOUR_MIB_AND_V2_TIMELINE_REPLAY');
 const raceGrant=await grant(audioId),race=await Promise.allSettled([consumeOriginalPreview(owner,audioId,raceGrant),consumeOriginalPreview(owner,audioId,raceGrant)]);assert.equal(race.filter(result=>result.status==='fulfilled').length,1);check('CONCURRENT_CONSUME_SUCCEEDS_EXACTLY_ONCE');
 const changed=await grant(pdfId);await db.update(artifacts).set({ownerId:f.other.userId}).where(eq(artifacts.id,document.id));
 await assert.rejects(consumeOriginalPreview(owner,pdfId,changed),/SOURCE_CHANGED/);await db.update(artifacts).set({ownerId:f.userId}).where(eq(artifacts.id,document.id));check('OWNER_CHANGE_REVOKES_ORIGINAL_BINDING');
 const [part]=await db.select().from(artifactParts).where(eq(artifactParts.artifactId,document.id));await db.update(artifactParts).set({sha256:'0'.repeat(64)}).where(eq(artifactParts.id,part.id));
 await assert.rejects(consumeOriginalPreview(owner,pdfId,changed),/SOURCE_CHANGED/);await db.update(artifactParts).set({sha256:part.sha256}).where(eq(artifactParts.id,part.id));check('PART_MANIFEST_CHANGE_REVOKES_APPROVAL');
 const badPageId=snapshotId+':'+document.id+':3',badPageGrant=await grant(badPageId);await assert.rejects(consumeOriginalPreview(owner,badPageId,badPageGrant));
 const [unused]=await db.select().from(contentAccessRequests).where(eq(contentAccessRequests.id,badPageGrant));assert.equal(unused.usedAt,null);check('FAILED_PAGE_RENDER_DOES_NOT_BURN_GRANT');
 await db.update(artifacts).set({contentExpiresAt:new Date(0)}).where(eq(artifacts.id,document.id));assert.equal(await readOriginalResource(db,scope,pdfId),null);await db.update(artifacts).set({contentExpiresAt:document.contentExpiresAt}).where(eq(artifacts.id,document.id));check('EXPIRED_ORIGINAL_CANNOT_BE_DISCLOSED');
 const expiry=new Date(Date.now()+120000);
 const [retentionJob]=await db.insert(guardJobs).values({...job,id:randomUUID(),idempotencyKey:randomUUID(),createdAt:new Date(expiry.getTime()-180*86400000)}).returning();
 await db.transaction(tx=>enqueueMediaEvidenceSnapshot(tx,retentionJob,{views:[views[1]]}));
 const retentionId=mediaEvidenceId(scope,retentionJob.id);await publishMediaEvidence(scope,retentionId);
 await grant(retentionId+':'+audio.id+':0');
 assert.equal(await deleteExpiredMediaEvidence(scope,retentionId,undefined,new Date(expiry.getTime()+1000)),false);
 const [retained]=await db.select().from(mediaEvidenceSnapshots).where(eq(mediaEvidenceSnapshots.id,retentionId));assert.equal(retained.state,'READY');
 check('ACTIVE_ORIGINAL_GRANT_PRESERVES_SOURCE_SNAPSHOT');
 const browserGrant=await grant(audioId),browserPdfGrant=await grant(firstId),browserTextGrant=await grant(snapshotId,'MEDIA_EVIDENCE');
 writeFileSync(out+'/original-preview-fixture.json',JSON.stringify({jobId:job.id,alertId:alert.id,snapshotId,pdfId,firstId,audioId,browserGrant,browserPdfGrant,browserTextGrant,documentId:document.id,audioArtifactId:audio.id,synthetic:true},null,2));
 writeFileSync(out+'/original-preview.json',JSON.stringify({status:'PASS',scope:'REAL_PG_MINIO_PDF_RENDERER_SYNTHETIC_EVIDENCE',realModelCalled:false,checks},null,2));
}
main().catch(error=>{writeFileSync(out+'/original-preview.json',JSON.stringify({status:'FAIL',checks,error:error instanceof Error?error.message.slice(0,300):'FAILED'},null,2));console.error(error instanceof Error?error.message:'FAILED');process.exitCode=1;}).finally(closeDatabaseConnection);
