import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
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
const tls = Object.fromEntries([['ca','ca.crt'],['cert','client.crt'],['key','client.key']].map(([key,file])=>[key,readFileSync(path.join(directory,'tls',file))]));
const hash = text => createHash('sha256').update(text).digest('hex');
const results = [], samples = {}, sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
function getModelCalls() { return new Promise((resolve,reject)=>https.get('https://127.0.0.1:58088/test/calls',{...tls,signal:AbortSignal.timeout(5000)},response=>{const buffers=[];response.on('data',b=>buffers.push(b));response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(buffers)));}catch(error){reject(error);}});response.on('error',reject);}).on('error',reject)); }
const reads = async () => (await (await fetch('http://127.0.0.1:58089/test/reads')).json()).length;
function post(reference,options={}) {
  const id=options.id??randomUUID(), tag=(options.delay?'DELAY_CASE ':'FILE_CALL ')+id;
  return new Promise((resolve,reject)=>{
    const request=https.request('https://127.0.0.1:58087/v1/chat/completions',{...tls,method:'POST',signal:AbortSignal.timeout(65000),headers:{'content-type':'application/json',authorization:'Bearer '+fixture.apiKey,'x-request-id':id,'idempotency-key':options.key??id}},response=>{
      const chunks=[];response.on('data',b=>chunks.push(b));response.on('end',()=>resolve({id,tag,status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));response.on('error',reject);
    });request.on('error',reject);request.end(JSON.stringify({model:'test',stream:false,messages:[{role:'system',content:'依据文件回答。'},{role:'user',content:tag}],guard_artifacts:[reference],...(options.rag?{guard_rag:{sourceIds:[sources.approved.sourceId]}}:{})}));
  });
}
async function test(id,name,run) {
  try { await run();results.push({id,name,status:'PASS'});console.log(id+' PASS '+name); }
  catch(error){results.push({id,name,status:'FAIL',detail:error.message.slice(0,300)});console.log(id+' FAIL '+name+' '+error.message.slice(0,300));}
}
try {
  for (const [name,source] of [['approved',sources.approved],['denied',sources.approved],['injection',sources.injection],['tampered',sources.tampered],['media',sources.approved],['revoked',sources.revocable]]) {
    const id=randomUUID(), digest=hash(source.text), owner=name==='denied'?'other-principal':principalId;
    await db.query(`insert into artifacts (tenant_id,application_id,id,owner_id,kind,file_name,declared_media_type,declared_size,verified_size,declared_sha256,verified_sha256,object_prefix,state,idempotency_key,request_hash,part_size,part_count,content_expires_at)
      select tenant_id,application_id,$1,$2,$3,file_name,declared_media_type,declared_size,verified_size,declared_sha256,verified_sha256,object_prefix,state,$4,request_hash,part_size,part_count,content_expires_at from artifacts where id=$5`,[id,owner,name==='media'?'IMAGE':'TEXT',randomUUID(),source.artifactId]);
    await db.query(`insert into artifact_parts (tenant_id,application_id,artifact_id,part_number,size_bytes,sha256,object_key,state,verified_at)
      select tenant_id,application_id,$1,part_number,size_bytes,sha256,object_key,state,verified_at from artifact_parts where artifact_id=$2`,[id,source.artifactId]);
    samples[name]={artifactId:id,sha256:digest};
  }
  await test('IT-FILE-01','verified owned text reaches the actual model with source proof',async()=>{
    const response=await post(samples.approved);assert.equal(response.status,200,response.body);
    const calls=(await getModelCalls()).filter(call=>call.messages.some(message=>typeof message.content==='string'&&message.content.includes(response.tag)));assert.equal(calls.length,1);
    const content=JSON.parse(calls[0].messages[1].content);assert.equal(content.kind,'untrusted_file_reference');assert.equal(content.text,sources.approved.text);assert.equal(content.instructionCapability,'FORBIDDEN');
    const row=(await db.query('select auth_context from gateway_requests where id=$1',[response.id])).rows[0];assert.match(row.auth_context.context.preparedRequestDigest,/^[a-f0-9]{64}$/);assert.match(row.auth_context.context.inputSegmentsDigest,/^[a-f0-9]{64}$/);
  });
  await test('IT-FILE-02','another owner is rejected before object read or model call',async()=>{
    const before=await reads(),models=(await getModelCalls()).length,response=await post(samples.denied);assert.equal(response.status,403,response.body);assert.equal(await reads(),before);assert.equal((await getModelCalls()).length,models);
  });
  await test('IT-FILE-03','wrong requested digest is rejected before object read',async()=>{
    const before=await reads(),response=await post({...samples.approved,sha256:'f'.repeat(64)});assert.equal(response.status,403,response.body);assert.equal(await reads(),before);
  });
  await test('IT-FILE-04','changed object bytes fail integrity and never reach a model',async()=>{
    const before=(await getModelCalls()).length,response=await post(samples.tampered);assert.ok(response.status>=400,response.body);assert.equal((await getModelCalls()).length,before);
  });
  await test('IT-FILE-05','indirect file injection is blocked by the common input guard',async()=>{
    const before=(await getModelCalls()).length,response=await post(samples.injection);assert.equal(response.status,403,response.body);assert.equal((await getModelCalls()).length,before);assert.ok(!response.body.includes(sources.injection.text));
  });
  await test('IT-FILE-06','media explicitly requires asynchronous coverage instead of text-only approval',async()=>{
    const before=await reads(),response=await post(samples.media);assert.equal(response.status,422,response.body);assert.match(response.body,/ARTIFACT_ASYNC_ANALYSIS_REQUIRED/);assert.equal(await reads(),before);
  });
  await test('IT-FILE-07','RAG and file references coexist without granting instruction authority',async()=>{
    const response=await post(samples.approved,{rag:true});assert.equal(response.status,200,response.body);const call=(await getModelCalls()).find(c=>c.messages.some(m=>m.content===response.tag));assert.ok(call);
    assert.equal(JSON.parse(call.messages[1].content).kind,'untrusted_rag_reference');assert.equal(JSON.parse(call.messages[2].content).kind,'untrusted_file_reference');assert.equal(call.messages[1].role,'user');assert.equal(call.messages[2].role,'user');
  });
  await test('IT-FILE-08','owner revocation while the model is running prevents output release',async()=>{
    const id=randomUUID(),pending=post(samples.revoked,{id,delay:true});let seen=false;
    for(let i=0;i<150;i++){if((await getModelCalls()).some(c=>c.messages.some(m=>typeof m.content==='string'&&m.content.includes(id)))){seen=true;break;}await sleep(50);}assert.ok(seen);
    try { await db.query('update artifacts set owner_id=$1 where id=$2',['revoked-owner',samples.revoked.artifactId]);const response=await pending;assert.equal(response.status,403,response.body);assert.equal((await db.query("select id from gateway_execution_events where request_id=$1 and kind='WRITE_ACCEPTED'",[id])).rowCount,0); }
    finally {await db.query('update artifacts set owner_id=$1 where id=$2',[principalId,samples.revoked.artifactId]);}
  });
  await test('IT-FILE-09','sequential idempotency replay rereads no object and calls no model',async()=>{
    const key=randomUUID();assert.equal((await post(samples.approved,{key})).status,200);const before=await reads(),models=(await getModelCalls()).length;assert.equal((await post(samples.approved,{key})).status,409);assert.equal(await reads(),before);assert.equal((await getModelCalls()).length,models);
  });
  await test('IT-FILE-10','quarantined and expired references cannot be consumed',async()=>{
    const prior=(await db.query('select content_expires_at from artifacts where id=$1',[samples.approved.artifactId])).rows[0].content_expires_at;
    try {await db.query("update artifacts set state='quarantined' where id=$1",[samples.approved.artifactId]);assert.equal((await post(samples.approved)).status,403);await db.query("update artifacts set state='accepted',content_expires_at=now()-interval '1 second' where id=$1",[samples.approved.artifactId]);assert.equal((await post(samples.approved)).status,403);}
    finally {await db.query("update artifacts set state='accepted',content_expires_at=$1 where id=$2",[prior,samples.approved.artifactId]);}
  });
  await test('IT-FILE-11','concurrent same-body retries read one object and reserve one business charge',async()=>{
    const id=randomUUID(), before=await reads(), responses=await Promise.all([post(samples.approved,{id}),post(samples.approved,{id}),post(samples.approved,{id})]);
    assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(responses.filter(r=>r.status===409).length,2);assert.equal(await reads()-before,1);
    for(let attempt=0;attempt<50;attempt++){const state=(await db.query('select state from gateway_request_resources where request_id=$1',[id])).rows[0]?.state;if(state!=='RESERVED')break;await sleep(100);}
    const ledger=(await db.query('select state,inspection_steps,prepared_references,settlement from gateway_request_resources where request_id=$1',[id])).rows;
    assert.equal(ledger.length,1);assert.equal(ledger[0].state,'SETTLED');assert.equal(ledger[0].inspection_steps,2);assert.equal(ledger[0].prepared_references,1);assert.equal(ledger[0].settlement.businessRequestCharge,1);
  });
  await test('IT-FILE-12','preparation denial retains a terminal claim and releases capacity without model charges',async()=>{
    const response=await post(samples.denied);assert.equal(response.status,403);
    const request=(await db.query('select state,session_finalized from gateway_requests where id=$1',[response.id])).rows[0];assert.equal(request.state,'TERMINATED');assert.equal(request.session_finalized,true);
    const ledger=(await db.query('select state,inspection_steps,settlement from gateway_request_resources where request_id=$1',[response.id])).rows[0];
    assert.equal(ledger.state,'SETTLED');assert.equal(ledger.inspection_steps,0);assert.equal(ledger.settlement.modelOutcome,'NOT_SENT');assert.equal(ledger.settlement.released.concurrencySlots,1);
    assert.ok(ledger.settlement.unmeasured.includes('MONETARY_COST'));
    assert.equal((await post(samples.denied,{id:response.id})).status,409);
  });
} finally {
  await db.end();const status=results.length===12&&results.every(r=>r.status==='PASS')?'PASS':'FAIL';
  writeFileSync(path.join(directory,'artifact-model-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),status,modelInvocationProven:true,model:'synthetic TLS model',objectStore:'synthetic loopback receiver',realMultimodalQuality:false,results},null,2));
  if(status!=='PASS')process.exitCode=1;
}
