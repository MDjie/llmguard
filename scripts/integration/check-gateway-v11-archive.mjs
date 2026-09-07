import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import pg from 'pg';
const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const environment = JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8')), fixture = JSON.parse(readFileSync(path.join(directory,'fixture.json'),'utf8'));
const url = new URL(environment.PGDATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
const db = new pg.Client({ connectionString: environment.PGDATABASE_URL, ssl: false }); await db.connect();
const tls = Object.fromEntries([['ca','ca.crt'],['cert','client.crt'],['key','client.key']].map(([key,file]) => [key,readFileSync(path.join(directory,'tls',file))]));
const results = [];
function request(text, stream=false) {
  const id = randomUUID(), body = {model:'test',stream,messages:[{role:'user',content:text+' '+id}]};
  return new Promise((resolve,reject) => { const req=https.request('https://127.0.0.1:58087/v1/chat/completions',{...tls,method:'POST',signal:AbortSignal.timeout(65000),headers:{'content-type':'application/json',authorization:'Bearer '+fixture.apiKey,'x-request-id':id,'idempotency-key':id,'x-guard-deadline':String(Date.now()+45000)}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({id,status:res.statusCode,body:Buffer.concat(chunks).toString('utf8'),input:body}));res.on('error',reject);});req.on('error',reject);req.end(JSON.stringify(body));});
}
async function archive(id) {
  for(let i=0;i<50;i++){ const row=(await db.query('select * from conversation_archives where request_id=$1',[id])).rows[0];if(row&&row.state!=='OPEN')return row;await new Promise(resolve=>setTimeout(resolve,100)); }
  return (await db.query('select * from conversation_archives where request_id=$1',[id])).rows[0];
}
async function test(id,run){try{await run();results.push({id,status:'PASS'});console.log('PASS '+id);}catch(error){results.push({id,status:'FAIL',reason:error instanceof Error?error.message:'failure'});throw error;}}
try {
  await test('ARCHIVE-PROXY-01 four purposes confirmed before successful JSON release',async()=>{
    const res=await request('ARCHIVE_NORMAL');assert.equal(res.status,200,res.body);const row=await archive(res.id);assert.equal(row.state,'COMMITTED',JSON.stringify(row.integrity));
    const objects=(await db.query('select purpose,state,object_version,spool from archived_content_objects where request_id=$1',[res.id])).rows;
    assert.deepEqual(objects.map(o=>o.purpose).sort(),['MODEL_INPUT','MODEL_OUTPUT','RECEIVED_INPUT','RELEASED_OUTPUT']);assert.ok(objects.every(o=>o.state==='MANIFEST_COMMITTED'&&o.object_version&&o.spool===null));
  });
  await test('ARCHIVE-PROXY-02 blocked original output survives without released output',async()=>{
    const res=await request('OUTPUT_BLOCK_CASE');assert.equal(res.status,403,res.body);assert.ok(!res.body.includes('SYNTHETIC_BLOCK_MARKER'));const row=await archive(res.id);assert.equal(row.state,'COMMITTED',JSON.stringify(row.integrity));
    const purposes=(await db.query('select purpose from archived_content_objects where request_id=$1',[res.id])).rows.map(o=>o.purpose);assert.ok(purposes.includes('MODEL_OUTPUT'));assert.ok(!purposes.includes('RELEASED_OUTPUT'));
  });
  await test('ARCHIVE-PROXY-03 complete SSE retains ordered raw events and release proof',async()=>{
    const res=await request('ARCHIVE_SSE',true);assert.equal(res.status,200,res.body);assert.ok(res.body.includes('[DONE]'));const row=await archive(res.id);assert.equal(row.state,'COMMITTED',JSON.stringify(row.integrity));
    const objects=(await db.query("select sequence,representation from archived_content_objects where request_id=$1 and purpose='MODEL_OUTPUT' order by sequence",[res.id])).rows;
    assert.ok(objects.length>2);assert.ok(objects.every((o,i)=>o.sequence===i&&o.representation==='SSE_EVENT'));assert.equal(row.model_output_final_sequence,objects.length-1);
  });
  for(const [tag,stream] of [['NATIVE_OUTPUT_INLINE',false],['NATIVE_OUTPUT_REMOTE',false],['NATIVE_OUTPUT_INLINE',true]])await test('NATIVE-OUTPUT-'+tag+'-'+stream+' isolates media without release',async()=>{
    const res=await request(tag,stream);assert.ok(res.status>=400,res.body);assert.ok(!res.body.includes('data:image'));const row=await archive(res.id);
    const state=(await db.query('select state from gateway_requests where id=$1',[res.id])).rows[0];assert.equal(state.state,'REVIEW_REQUIRED');
    const released=(await db.query("select id from gateway_execution_events where request_id=$1 and kind in ('WRITE_ACCEPTED','RELEASE_INTENT')",[res.id])).rows;assert.equal(released.length,0);
    const stored=(await db.query("select id from archived_content_objects where request_id=$1 and purpose='MODEL_OUTPUT' and state='MANIFEST_COMMITTED'",[res.id])).rows;assert.ok(stored.length>0);
    const notice=(await db.query("select payload from decision_record_outbox where payload->>'requestId'=$1 and payload->'findings'->0->>'reasonCode'='NATIVE_OUTPUT_REVIEW_REQUIRED'",[res.id])).rows;assert.equal(notice.length,1);
    if(tag==='NATIVE_OUTPUT_REMOTE'||stream)assert.equal(row.state,'GAPPED');else assert.equal(row.state,'COMMITTED',JSON.stringify(row.integrity));
  });
  await test('ARCHIVE-PROXY-04 archive write failure denies upstream send',async()=>{
    await fetch('http://127.0.0.1:58089/test/fault?writes=fail',{method:'POST'});
    try {const res=await request('ARCHIVE_STORE_FAILED');assert.ok(res.status>=400);const events=(await db.query("select id from gateway_execution_events where request_id=$1 and kind in ('UPSTREAM_SEND_STARTED','WRITE_ACCEPTED')",[res.id])).rows;assert.equal(events.length,0);const row=await archive(res.id);assert.notEqual(row.state,'COMMITTED');}
    finally{await fetch('http://127.0.0.1:58089/test/fault?writes=ok',{method:'POST'});}
  });
} finally {await db.end();writeFileSync('.artifact-build/v11-all-20260908/p3-proxy.json',JSON.stringify({status:results.length===7&&results.every(r=>r.status==='PASS')?'PASS':'FAIL',objectStore:'LOOPBACK_VERSIONED_PROTOCOL_FIXTURE',realS3Acceptance:false,results},null,2));}
