import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, X509Certificate } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import type { CodeScanRequest } from '../../src/lib/connectors/code-sentinel';
async function main() {
  const directory=path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment:Record<string,string>=JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
  const fixture:{tenantId:string;applicationId:string;bundleId:string;credentialId:string}=JSON.parse(readFileSync(path.join(directory,'fixture.json'),'utf8'));
  const url=new URL(environment.PGDATABASE_URL);if(url.hostname!=='127.0.0.1'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env,environment);
  const [{db,closeDatabaseConnection},s,jobs,code,{sha256},{verifyPayload}]=await Promise.all([import('../../src/storage/database/shared/db'),import('../../src/storage/database/shared/schema'),import('../../src/lib/guard-jobs/service'),import('../../src/lib/connectors/code-sentinel'),import('../../src/lib/gateway-runtime/protocol'),import('../../src/lib/gateway-runtime/security')]);
  const scope={tenantId:fixture.tenantId,applicationId:fixture.applicationId},ownerId='application-credential:'+fixture.credentialId;
  const objects=new Map<string,string>();let objectReads=0,scans=0;
  const objectServer=createServer((req,res)=>{const target=new URL(req.url??'/','http://127.0.0.1');const text=objects.get(target.pathname);if(!target.searchParams.has('X-Amz-Signature')||text===undefined){res.writeHead(403).end();return;}objectReads++;res.end(text);});
  objectServer.listen(0,'127.0.0.1');await once(objectServer,'listening');const objectAddress=objectServer.address();assert.ok(objectAddress&&typeof objectAddress!=='string');
  process.env.OBJECT_STORE_ENDPOINT='http://127.0.0.1:'+objectAddress.port;process.env.OBJECT_STORE_ALLOWED_PRIVATE_HOSTS='127.0.0.1';
  const tlsFile=(name:string)=>path.join(directory,'tls',name);
  const scanServer=createHttpsServer({ca:readFileSync(tlsFile('ca.crt')),cert:readFileSync(tlsFile('server.crt')),key:readFileSync(tlsFile('server.key')),requestCert:true,rejectUnauthorized:true},async(req,res)=>{
    try{
      const buffers:Buffer[]=[];for await(const chunk of req)buffers.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(buffers).toString('utf8')) as CodeScanRequest;
      code.verifyCodeScanAuthorization(body,String(req.headers['x-guard-request-digest']),String(req.headers['x-guard-connector-key-id']),String(req.headers['x-guard-connector-signature']));scans++;
      assert.equal(body.subjectId,ownerId);assert.equal(sha256(body.source),body.sourceSha256);assert.equal(body.operation,'SCAN_CODE');
      if(body.source.includes('# delay'))await new Promise(resolve=>setTimeout(resolve,1500));
      const mode=body.source.includes('# forged')?'forged':body.source.includes('# high')?'high':body.source.includes('# partial')?'partial':'safe';
      const reply={protocolVersion:'1.0',jobId:body.jobId,...scope,artifactId:body.artifactId,sourceSha256:body.sourceSha256,requestDigest:mode==='forged'?'f'.repeat(64):String(req.headers['x-guard-request-digest']),configurationDigest:body.configurationDigest,adapterId:body.adapterId,engineVersion:body.engineVersion,ruleSetDigest:body.ruleSetDigest,status:'SUCCEEDED',coverage:{state:mode==='partial'?'INCOMPLETE':'COMPLETE',language:body.language,processedBytes:Buffer.byteLength(body.source),riskIds:['unsafe_code']},findings:mode==='high'?[{ruleId:'synthetic-code-rule',riskId:'unsafe_code',severity:'HIGH',startLine:1,endLine:1,evidenceDigest:sha256('synthetic metadata')}]:[],completedAtEpochMs:Date.now()};
      res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
    }catch{res.destroy();}
  });
  scanServer.listen(0,'127.0.0.1');await once(scanServer,'listening');const address=scanServer.address();assert.ok(address&&typeof address!=='string');
  const config={...scope,adapterId:'isolated-codesentinel-contract',endpoint:'https://127.0.0.1:'+address.port+'/scan',caFile:tlsFile('ca.crt'),certificateFile:tlsFile('client.crt'),keyFile:tlsFile('client.key'),serverCertificateSha256:new X509Certificate(readFileSync(tlsFile('server.crt'))).fingerprint256.replaceAll(':','').toLowerCase(),timeoutMs:10000,maximumResponseBytes:1048576,engineVersion:'fixture-1',ruleSetDigest:sha256('fixture-rules'),languages:['python'],riskIds:['unsafe_code'],allowedDataClasses:['public','internal','sensitive','confidential'],maximumSourceBytes:1048576,expiresAt:Date.now()+3600000};
  delete process.env.CODE_SENTINEL_ADAPTERS_FILE;process.env.CODE_SENTINEL_ADAPTERS_JSON=JSON.stringify([config]);
  const results:{name:string;status:string}[]=[];
  async function test(name:string,run:()=>Promise<void>){await run();results.push({name,status:'PASS'});console.log('PASS '+name);}
  async function source(mode:string){
    const id=randomUUID(),text='# '+mode+'\nprint("isolated sample")\n',hash=sha256(text),bytes=Buffer.byteLength(text),key=id+'/part1';objects.set('/isolated/'+key,text);
    await db.insert(s.artifacts).values({...scope,id,ownerId,kind:'TEXT',fileName:'sample.py',declaredMediaType:'text/plain',declaredSize:bytes,verifiedSize:bytes,declaredSha256:hash,verifiedSha256:hash,objectPrefix:id,state:'accepted',idempotencyKey:randomUUID(),requestHash:hash,partSize:16777216,partCount:1,contentExpiresAt:new Date(Date.now()+3600000),metadata:{language:'python'}});
    await db.insert(s.artifactParts).values({...scope,artifactId:id,partNumber:1,sizeBytes:bytes,sha256:hash,objectKey:key,state:'verified',verifiedAt:new Date()});return{id,text};
  }
  async function submit(mode:string){const artifact=await source(mode);const result=await jobs.submitGuardJob({scope,ownerId,artifactId:artifact.id,bundleId:fixture.bundleId,jobType:'code_scan',idempotencyKey:randomUUID(),maxAttempts:1});return {job:result.job,artifact};}
  async function running(job:typeof s.guardJobs.$inferSelect){const [row]=await db.update(s.guardJobs).set({status:'running',attempt:1,heartbeatAt:new Date()}).where(eq(s.guardJobs.id,job.id)).returning();return row;}
  try{
    await test('signed code scan uses owned verified content and persists no source in its result',async()=>{
      const {job,artifact}=await submit('safe');assert.ok(job.executionBinding);await code.processNextCodeScanJob();const[row]=await db.select().from(s.guardJobs).where(eq(s.guardJobs.id,job.id));assert.equal(row.status,'completed');assert.equal(row.result?.action,'ALLOW');assert.ok(!JSON.stringify(row.result).includes(artifact.text));
      const proof=row.result?.proof as {manifest:Record<string,unknown>;keyId:string;signature:string};verifyPayload('gateway-codesentinel-result-v1',proof.manifest,proof.keyId,proof.signature);
    });
    await test('high severity findings block and incomplete coverage requires review',async()=>{
      for(const[mode,expected]of[['high','BLOCK'],['partial','REQUIRE_REVIEW']]){const{job}=await submit(mode);const row=await running(job);const result=await code.processCodeScanJob(row,new AbortController().signal);assert.equal(result.action,expected);await jobs.completeGuardJob(row,result);}
    });
    await test('forged receipt fails the job instead of publishing an allowed result',async()=>{
      const{job}=await submit('forged');await code.processNextCodeScanJob();const[row]=await db.select().from(s.guardJobs).where(eq(s.guardJobs.id,job.id));assert.equal(row.status,'failed');assert.ok(!row.result?.action);
    });
    await test('changed configuration invalidates a queued job before source read or scan',async()=>{
      const{job}=await submit('safe'),readsBefore=objectReads,scansBefore=scans;
      process.env.CODE_SENTINEL_ADAPTERS_JSON=JSON.stringify([{...config,engineVersion:'fixture-2'}]);
      try{await assert.rejects(code.processCodeScanJob(job,new AbortController().signal));assert.equal(objectReads,readsBefore);assert.equal(scans,scansBefore);}
      finally{process.env.CODE_SENTINEL_ADAPTERS_JSON=JSON.stringify([config]);await jobs.cancelGuardJob(scope,ownerId,job.id);}
    });
    await test('cross-principal and unapproved-language submissions read no object',async()=>{
      const artifact=await source('safe'),before=objectReads;
      await assert.rejects(jobs.submitGuardJob({scope,ownerId:'different',artifactId:artifact.id,bundleId:fixture.bundleId,jobType:'code_scan',idempotencyKey:randomUUID(),maxAttempts:1}));
      await db.update(s.artifacts).set({metadata:{language:'unknown-language'}}).where(eq(s.artifacts.id,artifact.id));await assert.rejects(code.captureCodeScanBinding(scope,ownerId,artifact.id));assert.equal(objectReads,before);
    });
    await test('source ownership revoked during analysis prevents publication',async()=>{
      const{job,artifact}=await submit('delay'),row=await running(job),before=scans,pending=code.processCodeScanJob(row,new AbortController().signal);
      for(let i=0;i<100&&scans===before;i++)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(scans,before+1);
      await db.update(s.artifacts).set({ownerId:'revoked'}).where(eq(s.artifacts.id,artifact.id));await assert.rejects(pending);await jobs.failGuardJob(row,new Error('isolated revocation'));
    });
    await test('frozen adapter and source binding cannot be replaced in storage',async()=>{
      const{job}=await submit('safe');await assert.rejects(db.update(s.guardJobs).set({executionBinding:{forged:true}}).where(eq(s.guardJobs.id,job.id)));await jobs.cancelGuardJob(scope,ownerId,job.id);
    });
  }finally{
    scanServer.close();scanServer.closeAllConnections();objectServer.close();objectServer.closeAllConnections();await closeDatabaseConnection();
    writeFileSync(path.join(directory,'code-sentinel-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),status:results.length===7?'PASS':'FAIL',isolatedDatabase:true,adapter:'synthetic pinned-mTLS protocol fixture',realCodeSentinelCertification:false,results},null,2));
  }
}
main().catch(error=>{console.error('CODE_SENTINEL_INTEGRATION_FAILED',error instanceof Error?error.message:'UNKNOWN');process.exitCode=1;});
