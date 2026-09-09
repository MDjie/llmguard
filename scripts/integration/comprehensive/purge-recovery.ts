import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {eq,ne} from 'drizzle-orm';
import {db,closeDatabaseConnection} from '@/storage/database/shared/db';
import {artifacts,artifactPurgeLedger,guardJobs} from '@/storage/database/shared/schema';
import {createArtifactUpload,signArtifactPart} from '@/lib/artifacts/service';
import {storeVerifiedBytes} from '@/lib/artifacts/server-upload';
import {persistNormalizedAsset} from '@/lib/artifacts/normalized';
import {projectText} from '@/lib/artifacts/normalized-projection';
import {submitGuardJob,claimNextGuardJob,cancelGuardJob} from '@/lib/guard-jobs';
import {enqueueExpiredArtifacts,requestArtifactPurge,purgeNextArtifact} from '@/lib/artifacts/purge';
import {S3ArtifactVersionStore} from '@/lib/artifacts/version-store';
const out=resolve(process.env.COMPREHENSIVE_RUN_DIR!);
const f=JSON.parse(readFileSync(out+'/fixture.private.json','utf8')) as {tenantId:string;applicationId:string;userId:string;bundleId:string};
const scope={tenantId:f.tenantId,applicationId:f.applicationId},ownerId=f.userId,checks:Array<{id:string;status:'PASS'}>=[];
const check=(id:string)=>{checks.push({id,status:'PASS'});console.log(id+' PASS');};
async function processOnce(mode:string,name:string){
 const file=out+'/'+name+'.json';
 const result=await new Promise<number>((done,reject)=>{
  const child=spawn(process.execPath,['--import','tsx','scripts/integration/comprehensive/purge-recovery-child.ts',mode,file],{env:process.env,stdio:'ignore',windowsHide:true});
  const timer=setTimeout(()=>{child.kill();reject(new Error('PURGE_TEST_CHILD_TIMEOUT'));},30000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);done(code??1);});
 });
 return {code:result,data:JSON.parse(readFileSync(file,'utf8')) as {crashedAfterVersionDelete?:boolean;result?:{artifactId:string;status:string}|null}};
}
async function due(id:string){
 await db.update(artifactPurgeLedger).set({notBefore:new Date(0),retryAt:new Date(0)}).where(eq(artifactPurgeLedger.artifactId,id));
}
async function main(){
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5438');assert.match(url.pathname,/^\/guardllm_integration_full_\d+$/);
 assert.equal((await db.select().from(artifactPurgeLedger).where(ne(artifactPurgeLedger.state,'PURGED'))).length,0,'Start with no pending cleanup work in the isolated database');
 const bytes=Buffer.from('Only newly created synthetic objects are removed.'),uploadBytes=Buffer.alloc(17*1024*1024,65),sha=createHash('sha256').update(uploadBytes).digest('hex');
 const {artifact}=await createArtifactUpload({scope,ownerId,kind:'TEXT',fileName:'crash-recovery.txt',mediaType:'text/plain',sizeBytes:uploadBytes.length,sha256:sha,idempotencyKey:randomUUID(),retentionDays:1,metadata:{}});
 for(let number=1;number<=artifact.partCount;number++){const signed=await signArtifactPart(scope,ownerId,artifact.id,number);const part=uploadBytes.subarray((number-1)*artifact.partSize,Math.min(number*artifact.partSize,uploadBytes.length));const response=await fetch(signed.url,{method:'PUT',headers:signed.headers,body:part,signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);await response.body?.cancel();}
 uploadBytes.fill(0);
 const store=new S3ArtifactVersionStore();assert.equal((await store.list(artifact.objectPrefix,artifact.partCount)).length,2);
 await requestArtifactPurge(scope,ownerId,artifact.id);await due(artifact.id);
 const crash=await processOnce('crash-after-delete','purge-crash-child');assert.notEqual(crash.code,0);assert.equal(crash.data.crashedAfterVersionDelete,true);writeFileSync(out+'/purge-crash-observed.json',JSON.stringify({intentionalCrashMarker:true,exitCode:crash.code}));
 const [crashed]=await db.select().from(artifactPurgeLedger).where(eq(artifactPurgeLedger.artifactId,artifact.id));
 assert.equal(crashed.state,'DELETING');assert.equal(crashed.versions.length,2);assert.ok(crashed.leaseToken);
 assert.equal((await store.list(artifact.objectPrefix,artifact.partCount)).length,1);
 assert.equal((await db.select().from(artifacts).where(eq(artifacts.id,artifact.id)))[0].purgedAt,null);check('REAL_WORKER_CRASH_PRESERVES_LEDGER_AND_QUOTA');
 const leased=await processOnce('resume','purge-before-lease-expiry');assert.equal(leased.code,0);assert.equal(leased.data.result,null);check('RESTART_CANNOT_STEAL_LIVE_LEASE');
 // The restart is real; only this synthetic lease/TTL clock is advanced to avoid a long sleep.
 await db.update(artifactPurgeLedger).set({leaseUntil:new Date(0)}).where(eq(artifactPurgeLedger.artifactId,artifact.id));
 const recovered=await processOnce('resume','purge-after-lease-expiry');assert.equal(recovered.code,0);assert.equal(recovered.data.result?.artifactId,artifact.id);assert.equal(recovered.data.result?.status,'purged');
 assert.equal((await store.list(artifact.objectPrefix,artifact.partCount)).length,0);
 const [finished]=await db.select().from(artifactPurgeLedger).where(eq(artifactPurgeLedger.artifactId,artifact.id));assert.equal(finished.state,'PURGED');assert.equal(finished.attempt,2);assert.equal(finished.versions.length,2);check('FRESH_PROCESS_RESUMES_EXACT_REMAINING_VERSION');
 const parent=await storeVerifiedBytes({scope,ownerId,kind:'TEXT',fileName:'referenced-parent.txt',mediaType:'text/plain',bytes});
 const submitted=await submitGuardJob({scope,ownerId,artifactId:parent.id,sourceArtifactIds:[parent.id],bundleId:f.bundleId,jobType:'intake',idempotencyKey:randomUUID(),maxAttempts:1});
 const job=await claimNextGuardJob(['intake']);assert.equal(job?.id,submitted.job.id);assert.ok(job);
 const child=await persistNormalizedAsset(job,projectText({parentArtifactId:parent.id,parentSha256:parent.verifiedSha256!,sourceKind:'TEXT'},bytes.toString('utf8'),'utf-8'));
 await cancelGuardJob(scope,ownerId,job.id);
 await db.update(artifacts).set({contentExpiresAt:new Date(0)}).where(eq(artifacts.id,parent.id));
 await enqueueExpiredArtifacts();await due(parent.id);
 assert.equal(await purgeNextArtifact(store),null);
 assert.equal((await db.select().from(artifacts).where(eq(artifacts.id,parent.id)))[0].state,'accepted');
 assert.ok((await store.list(parent.objectPrefix,parent.partCount)).length);check('EXPIRED_PARENT_RETAINED_WHILE_CHILD_REFERENCES_IT');
 await db.update(artifacts).set({state:'quarantined'}).where(eq(artifacts.id,child.artifactId));await requestArtifactPurge(scope,ownerId,child.artifactId);await due(child.artifactId);
 assert.equal((await purgeNextArtifact(store))?.artifactId,child.artifactId);
 await due(parent.id);const released=await processOnce('resume','purge-released-parent');assert.equal(released.data.result?.artifactId,parent.id);assert.equal(released.data.result?.status,'purged');
 assert.equal((await store.list(parent.objectPrefix,parent.partCount)).length,0);check('CHILD_PURGE_RELEASES_PARENT_REFERENCE_ON_RESTART');
 const final=await processOnce('resume','purge-final-noop');assert.equal(final.data.result,null);check('COMPLETED_LEDGER_IS_IDEMPOTENT_AFTER_RESTART');
 const [cancelled]=await db.select().from(guardJobs).where(eq(guardJobs.id,job.id));assert.equal(cancelled.status,'cancelled');
 writeFileSync(out+'/purge-recovery.json',JSON.stringify({status:'PASS',scope:'REAL_CHILD_PROCESS_CRASH_AND_RESTART_WITH_PG_MINIO',clock:'CONTROLLED_SYNTHETIC_LEASE_AND_TTL',productionCleanupEnabled:false,checks},null,2));
}
main().catch(error=>{writeFileSync(out+'/purge-recovery.json',JSON.stringify({status:'FAIL',checks,error:error instanceof Error?error.message.slice(0,300):'FAILED'},null,2));console.error(error instanceof Error?error.message:'FAILED');process.exitCode=1;}).finally(closeDatabaseConnection);
