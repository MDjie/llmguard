import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import pg from 'pg';
const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const environment = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
const { sources, principalId } = JSON.parse(readFileSync(path.join(directory, 'rag-model-fixture.json'), 'utf8'));
const url = new URL(environment.PGDATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
const db = new pg.Client({ connectionString: environment.PGDATABASE_URL, ssl: false }); await db.connect();
const tls = Object.fromEntries([['ca','ca.crt'],['cert','client.crt'],['key','client.key']].map(([name,file]) => [name,readFileSync(path.join(directory,'tls',file))]));
const results = [], sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function calls() {
  return new Promise((resolve,reject) => https.get('https://127.0.0.1:58088/test/calls',{...tls,signal:AbortSignal.timeout(5000)},response=>{
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)));}catch(error){reject(error);}});response.on('error',reject);
  }).on('error',reject));
}
async function post(source, options = {}) {
  const id=options.id??randomUUID(), tag=(options.delay?'DELAY_CASE ':'RAG_CALL ')+id;
  return new Promise((resolve,reject)=>{
    const request=https.request('https://127.0.0.1:58087/v1/chat/completions',{...tls,method:'POST',signal:AbortSignal.timeout(65000),headers:{'content-type':'application/json',authorization:'Bearer '+fixture.apiKey,'x-request-id':id,'idempotency-key':options.key??id}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({id,tag,status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));response.on('error',reject);
    });request.on('error',reject);request.end(JSON.stringify({model:'test',stream:false,messages:[{role:'system',content:'请根据已授权资料回答。'},{role:'user',content:tag}],guard_rag:{sourceIds:[source.sourceId],maximumCandidates:5,minimumTrustLevel:20,...options.extra}}));
  });
}
async function test(id,name,run) {
  try{await run();results.push({id,name,status:'PASS'});console.log(id+' PASS '+name);}catch(error){results.push({id,name,status:'FAIL',detail:error.message.slice(0,350)});console.log(id+' FAIL '+name+' '+error.message.slice(0,350));}
}
try {
  await test('IT-RAG-MODEL-01','approved context reaches the actual model as untrusted user data and binds audit to business request',async()=>{
    const r=await post(sources.approved);assert.equal(r.status,200,r.body);
    const sent=(await calls()).filter(call=>call.messages.some(message=>typeof message.content==='string'&&message.content.includes(r.tag)));assert.equal(sent.length,1);
    assert.equal(sent[0].guard_rag,undefined);assert.equal(sent[0].messages.length,3);assert.equal(sent[0].messages[1].role,'user');
    const reference=JSON.parse(sent[0].messages[1].content);assert.equal(reference.text,sources.approved.text);assert.equal(reference.sourceId,sources.approved.sourceId);assert.equal(reference.instructionCapability,'FORBIDDEN');
    const request=(await db.query('select auth_context from gateway_requests where id=$1',[r.id])).rows[0];assert.equal(request.auth_context.context.subjectId,principalId);assert.match(request.auth_context.context.preparedRequestDigest,/^[a-f0-9]{64}$/);assert.match(request.auth_context.context.inputSegmentsDigest,/^[a-f0-9]{64}$/);
    const audit=(await db.query('select retrieval_proof,bundle_id from rag_retrieval_audits where request_id=$1',[r.id])).rows[0];assert.equal(audit.bundle_id,request.auth_context.context.policy.bundleId);assert.equal(audit.retrieval_proof.manifest.subjectId,principalId);assert.equal(audit.retrieval_proof.manifest.sourceReferences[0].artifactId,sources.approved.artifactId);assert.ok(!JSON.stringify(audit).includes(sources.approved.text));
  });
  await test('IT-RAG-MODEL-02','denied ACL performs no object read or model call',async()=>{
    const before=(await calls()).length,readsBefore=await(await fetch('http://127.0.0.1:58089/test/reads')).json();const r=await post(sources.denied);assert.equal(r.status,403,r.body);assert.equal((await calls()).length,before);
    const readsAfter=await(await fetch('http://127.0.0.1:58089/test/reads')).json();assert.equal(readsAfter.filter(key=>key===sources.denied.objectKey).length,readsBefore.filter(key=>key===sources.denied.objectKey).length);
  });
  await test('IT-RAG-MODEL-03','indirect injection is blocked before a model invocation',async()=>{
    const before=(await calls()).length,r=await post(sources.injection);assert.equal(r.status,403,r.body);assert.equal((await calls()).length,before);assert.ok(!r.body.includes(sources.injection.text));
  });
  await test('IT-RAG-MODEL-04','changed object bytes cannot enter the model',async()=>{
    const before=(await calls()).length,r=await post(sources.tampered);assert.ok(r.status>=400,r.body);assert.equal((await calls()).length,before);
  });
  await test('IT-RAG-MODEL-05','client cannot supply principal, clearance or trusted context flags',async()=>{
    const before=(await calls()).length,r=await post(sources.approved,{extra:{subjectId:'other',clearance:10,trusted:true}});assert.equal(r.status,400,r.body);assert.equal((await calls()).length,before);
  });
  await test('IT-RAG-MODEL-06','ACL revocation during upstream execution prevents output release',async()=>{
    const id=randomUUID(),promise=post(sources.revocable,{id,delay:true});
    let seen=false;for(let i=0;i<150;i++){if((await calls()).some(call=>call.messages.some(message=>typeof message.content==='string'&&message.content.includes(id)))){seen=true;break;}await sleep(50);}assert.ok(seen);
    try{
      await db.query('update rag_sources set acl=$1 where id=$2',[JSON.stringify({allowedPrincipals:['revoked'],allowedRoles:['APP_DEVELOPER']}),sources.revocable.sourceId]);
      const r=await promise;assert.equal(r.status,403,r.body);assert.match(r.body,/RAG_REFERENCE_REVOKED/);
      const writes=(await db.query("select id from gateway_execution_events where request_id=$1 and kind='WRITE_ACCEPTED'",[id])).rows;assert.equal(writes.length,0);
    }finally{await db.query('update rag_sources set acl=$1 where id=$2',[JSON.stringify({allowedPrincipals:[principalId],allowedRoles:['APP_DEVELOPER']}),sources.revocable.sourceId]);}
  });
  await test('IT-RAG-MODEL-07','idempotent retry never repeats retrieval or model invocation',async()=>{
    const key=randomUUID(),id=randomUUID(),first=await post(sources.approved,{key,id});assert.equal(first.status,200,first.body);const before=(await calls()).length;
    const again=await post(sources.approved,{key,id});assert.equal(again.status,409,again.body);assert.equal((await calls()).length,before);
    const audits=(await db.query('select id from rag_retrieval_audits where request_id=$1',[id])).rows;assert.equal(audits.length,1);
  });
} finally {
  await db.end();const report={schemaVersion:'1.0',createdAt:new Date().toISOString(),environment:'isolated real Java/Node/PostgreSQL with synthetic object receiver and model',evidenceClass:'ENGINEERING',modelInvocationProven:results.some(result=>result.id==='IT-RAG-MODEL-01'&&result.status==='PASS'),realSemanticQualityProven:false,passed:results.filter(result=>result.status==='PASS').length,failed:results.filter(result=>result.status==='FAIL').length,results};
  writeFileSync(path.resolve('.artifact-build/upgrade-implementation-20260907/rag-model-evidence.json'),JSON.stringify(report,null,2)+'\n');if(report.failed)process.exitCode=1;
}
