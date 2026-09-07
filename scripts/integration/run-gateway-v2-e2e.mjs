import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import pg from 'pg';
import { createRequire } from 'node:module';
const WebSocket = createRequire(import.meta.url)('next/dist/compiled/ws');

const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const environment = JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
const fixture = JSON.parse(readFileSync(path.join(directory,'fixture.json'),'utf8'));
const databaseUrl = new URL(environment.PGDATABASE_URL);
if (databaseUrl.hostname !== '127.0.0.1' || databaseUrl.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
const db = new pg.Client({connectionString:environment.PGDATABASE_URL,ssl:false});
await db.connect();
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const tls = {ca:readFileSync(path.join(directory,'tls/ca.crt')),cert:readFileSync(path.join(directory,'tls/client.crt')),key:readFileSync(path.join(directory,'tls/client.key'))};
async function calls() {
  return new Promise((resolve,reject) => {
    https.get('https://127.0.0.1:58088/test/calls',tls,response => { const chunks=[]; response.on('data',chunk=>chunks.push(chunk)); response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)));}catch(error){reject(error);}}); response.on('error',reject); }).on('error',reject);
  });
}
async function post(text, options = {}) {
  const id = options.id ?? randomUUID();
  return new Promise((resolve,reject)=>{
    const request = https.request('https://127.0.0.1:58087/v1/chat/completions', {...tls,method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+fixture.apiKey,'x-request-id':id,'idempotency-key':options.key??id,...options.headers},signal:options.signal??AbortSignal.timeout(65000)},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>resolve({id,status:response.statusCode,headers:new Headers(Object.entries(response.headers).filter(([,value])=>value!==undefined)),body:Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',reject);request.end(JSON.stringify(options.body??{model:'test',messages:[{role:'user',content:text}],stream:Boolean(options.stream)}));
  });
}
async function ready() {
  for(let attempt=0;attempt<60;attempt++){
    try { await new Promise((resolve,reject)=>https.get('https://127.0.0.1:58087/actuator/health/readiness',{...tls,signal:AbortSignal.timeout(2000)},r=>{r.resume();resolve();}).on('error',reject));return; }
    catch { await sleep(500); }
  }
  throw new Error('ISOLATED_PROXY_NOT_READY');
}
async function consolePost(text, options={}) {
  const fixture=JSON.parse(readFileSync(path.join(directory,'console-fixture.json'),'utf8'));
  const body={providerId:fixture.providerId,text,...options.body};
  return new Promise((resolve,reject)=>{
    const request=https.request('https://127.0.0.1:5107/api/chat',{...tls,method:'POST',signal:AbortSignal.timeout(65000),headers:{'content-type':'application/json',cookie:fixture.cookie,'x-csrf-token':fixture.csrfToken,'idempotency-key':randomUUID(),...options.headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });request.on('error',reject);request.end(JSON.stringify(body));
  });
}
async function websocket(text, options={}) {
  const id=randomUUID(),frames=[];
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket('wss://127.0.0.1:58087/v1/chat/completions/ws',{...tls,handshakeTimeout:5000,headers:{authorization:'Bearer '+fixture.apiKey,'x-request-id':id,...options.headers}});
    const timer=setTimeout(()=>{socket.terminate();reject(new Error('WS_TIMEOUT'));},65000);
    socket.on('open',()=>socket.send(JSON.stringify({model:'test',messages:[{role:'user',content:text}]})));
    socket.on('message',data=>frames.push(data.toString()));
    socket.on('error',error=>{clearTimeout(timer);reject(error);});
    socket.on('close',code=>{clearTimeout(timer);resolve({id,frames,code});});
  });
}
async function awaitFinalized(id) {
  for (let attempt=0;attempt<50;attempt++) {
    const row=(await db.query('select session_finalized from gateway_requests where id=$1',[id])).rows[0];
    if(row?.session_finalized)return;
    await sleep(100);
  }
  throw new Error('durable execution/session finalization did not complete within 5 seconds');
}
async function assertActionProof(id, kind, action, initialStage, recheckStage) {
  await awaitFinalized(id);
  const event=(await db.query('select * from gateway_execution_events where request_id=$1 and kind=$2',[id,kind])).rows[0];
  assert.equal(event.actual_action,action);
  const steps=(await db.query('select stage,decision_id from gateway_steps where request_id=$1',[id])).rows;
  assert.equal(event.decision_id,steps.find(step=>step.stage===initialStage).decision_id);
  assert.equal(event.recheck_decision_id,steps.find(step=>step.stage===recheckStage).decision_id);
}
async function test(id, name, fn) {
  try { await fn(); results.push({id,name,status:'PASS'}); console.log(id+' PASS '+name); }
  catch(error) { const detail = error instanceof assert.AssertionError ? error.message.slice(0,500) : error.message; results.push({id,name,status:'FAIL',detail}); console.log(id+' FAIL '+name+' '+detail); }
}
try {
  await ready();
  await test('IT-V2-01','normal completion and durable execution chain',async()=>{
    const r=await post('NORMAL_CASE'); assert.equal(r.status,200,r.body); assert.match(r.body,/真实检测/); await awaitFinalized(r.id);
    const events=(await db.query('select kind from gateway_execution_events where request_id=$1 order by event_seq',[r.id])).rows.map(row=>row.kind);
    assert.deepEqual(events,['UPSTREAM_SEND_INTENT','UPSTREAM_SEND_STARTED','RELEASE_INTENT','WRITE_ACCEPTED','COMPLETED']);
    const request=(await db.query('select state,session_finalized from gateway_requests where id=$1',[r.id])).rows[0]; assert.equal(request.state,'COMPLETED'); assert.equal(request.session_finalized,true);
  });
  await test('IT-V2-02','input MASK changes actual upstream content',async()=>{
    const before=(await calls()).length; const r=await post('请处理联系电话：13800138000'); assert.equal(r.status,200,r.body); assert.equal(r.headers.get('x-guard-input-action'),'MASK');
    const sent=(await calls()).slice(before); assert.equal(sent.length,1); assert.ok(!JSON.stringify(sent).includes('13800138000')); assert.match(JSON.stringify(sent),/\*|PHONE|手机/);
    const steps=(await db.query('select stage from gateway_steps where request_id=$1',[r.id])).rows.map(row=>row.stage); assert.ok(steps.includes('INPUT_RECHECK')); await assertActionProof(r.id,'UPSTREAM_SEND_INTENT','MASK','INPUT','INPUT_RECHECK');
  });
  await test('IT-V2-03','input BLOCK never calls upstream',async()=>{
    const before=(await calls()).length; const r=await post('SYNTHETIC_BLOCK_MARKER'); assert.equal(r.status,403,r.body); assert.equal((await calls()).length,before);
  });
  await test('IT-V2-04','output MASK changes actual client content',async()=>{
    const r=await post('OUTPUT_PHONE_CASE'); assert.equal(r.status,200,r.body); assert.equal(r.headers.get('x-guard-output-action'),'MASK'); assert.ok(!r.body.includes('13800138000')); await assertActionProof(r.id,'WRITE_ACCEPTED','MASK','OUTPUT_COMPLETE','OUTPUT_RECHECK');
  });
  await test('IT-V2-05','output BLOCK leaks no model text',async()=>{
    const r=await post('OUTPUT_BLOCK_CASE'); assert.equal(r.status,403,r.body); assert.ok(!r.body.includes('SYNTHETIC_BLOCK_MARKER'));
  });
  await test('IT-V2-06','standard stream=true handles fragmented UTF-8 and one DONE',async()=>{
    const r=await post('STREAM_CASE',{stream:true}); assert.equal(r.status,200,r.body); assert.match(r.headers.get('content-type'),/text\/event-stream/); assert.equal(r.body.split('[DONE]').length-1,1);
    const chunks=r.body.split('\n\n').map(line=>line.replace(/^data: /,'')).filter(line=>line&&line!=='[DONE]').map(line=>JSON.parse(line));
    const text=chunks.flatMap(chunk=>chunk.choices??[]).map(choice=>choice.delta?.content??'').join(''); assert.equal(text,'这是经过真实检测的模拟模型答复。');
  });
  await test('IT-V2-07','stream replacement contains no original sensitive delta',async()=>{
    const r=await post('OUTPUT_PHONE_CASE',{stream:true}); assert.equal(r.status,200,r.body); assert.ok(!r.body.includes('13800138000')); assert.equal(r.headers.get('x-guard-output-action'),'MASK'); assert.equal(r.body.split('[DONE]').length-1,1);
  });
  await test('IT-V2-08','truncated upstream stream releases no buffered content',async()=>{
    const r=await post('TRUNCATED_CASE',{stream:true}); assert.equal(r.status,502,r.body); assert.ok(!r.body.includes('模拟模型答复'));
  });
  await test('IT-V2-09','same idempotency key never invokes model twice',async()=>{
    const key=randomUUID(); const first=await post('IDEMPOTENCY_CASE',{key}); assert.equal(first.status,200,first.body); const before=(await calls()).length;
    const duplicate=await post('IDEMPOTENCY_CASE',{key}); assert.equal(duplicate.status,409,duplicate.body);
    const conflict=await post('DIFFERENT_CASE',{key}); assert.equal(conflict.status,409,conflict.body); assert.equal((await calls()).length,before);
  });
  await test('IT-V2-10','conflicting credentials are rejected before execution',async()=>{
    const before=(await calls()).length; const r=await post('IDENTITY_CASE',{headers:{'x-guard-api-key':'different'}}); assert.equal(r.status,401,r.body); assert.equal((await calls()).length,before);
  });
  await test('IT-V2-11','session request serializes and commits each direction once',async()=>{
    const session=randomUUID(); const first=post('DELAY_CASE',{headers:{'x-session-id':session}}); await sleep(400);
    const second=await post('SECOND_CASE',{headers:{'x-session-id':session}}); assert.equal(second.status,409,second.body);
    const completed=await first; assert.equal(completed.status,200,completed.body); await awaitFinalized(completed.id);
    const receipts=(await db.query('select direction from guard_session_request_receipts where session_id=$1 and request_id=$2 order by direction',[session,completed.id])).rows.map(row=>row.direction);
    assert.deepEqual(receipts,['INPUT','OUTPUT_COMPLETE']);
  });
  await test('IT-V2-13','unchecked generation fields are rejected without model call',async()=>{
    const before=(await calls()).length;
    for(const extra of [{hidden:'unchecked'},{temperature:'unchecked'},{store:true}]) {
      const r=await post('',{body:{model:'test',messages:[{role:'user',content:'NORMAL_CASE'}],...extra}}); assert.ok(r.status>=400&&r.status<500,r.body);
    }
    assert.equal((await calls()).length,before);
  });
  await test('IT-V2-14','structured response format is included in input detection',async()=>{
    const before=(await calls()).length;
    const r=await post('',{body:{model:'test',messages:[{role:'user',content:'NORMAL_CASE'}],response_format:{type:'json_schema',json_schema:{name:'test',description:'SYNTHETIC_BLOCK_MARKER',schema:{type:'object'}}}}});
    assert.equal(r.status,403,r.body); assert.equal((await calls()).length,before);
  });
  await test('IT-V2-15','input REWRITE uses approved template and preserves other messages',async()=>{
    const before=(await calls()).length;
    const r=await post('',{body:{model:'test',messages:[{role:'system',content:'你是测试助手。'},{role:'user',content:'INPUT_REWRITE_CASE'}]}});
    assert.equal(r.status,200,r.body);assert.equal(r.headers.get('x-guard-input-action'),'REWRITE');
    const sent=(await calls()).slice(before);assert.equal(sent.length,1);assert.equal(sent[0].messages[0].content,'你是测试助手。');assert.equal(sent[0].messages[1].content,'请按照已批准的业务规范提供帮助。');
    await assertActionProof(r.id,'UPSTREAM_SEND_INTENT','REWRITE','INPUT','INPUT_RECHECK');
  });
  await test('IT-V2-16','input SAFE_RESPONSE is rechecked without upstream invocation',async()=>{
    const before=(await calls()).length;const r=await post('INPUT_SAFE_CASE');assert.equal(r.status,200,r.body);assert.equal(r.headers.get('x-guard-input-action'),'SAFE_RESPONSE');assert.equal((await calls()).length,before);assert.ok(!r.body.includes('INPUT_SAFE_CASE'));
    await assertActionProof(r.id,'WRITE_ACCEPTED','SAFE_RESPONSE','INPUT','OUTPUT_RECHECK');
  });
  await test('IT-V2-17','output SAFE_RESPONSE replaces upstream bytes after recheck',async()=>{
    const r=await post('OUTPUT_SAFE_CASE',{stream:true});assert.equal(r.status,200,r.body);assert.equal(r.headers.get('x-guard-output-action'),'SAFE_RESPONSE');assert.ok(!r.body.includes('SYNTHETIC_SAFE_MARKER'));assert.equal(r.body.split('[DONE]').length-1,1);
    await assertActionProof(r.id,'WRITE_ACCEPTED','SAFE_RESPONSE','OUTPUT_COMPLETE','OUTPUT_RECHECK');
  });
  await test('IT-V2-18','output REWRITE has durable original and recheck decisions',async()=>{
    const r=await post('OUTPUT_REWRITE_CASE');assert.equal(r.status,200,r.body);assert.equal(r.headers.get('x-guard-output-action'),'REWRITE');assert.ok(!r.body.includes('SYNTHETIC_REWRITE_MARKER'));
    await assertActionProof(r.id,'WRITE_ACCEPTED','REWRITE','OUTPUT_COMPLETE','OUTPUT_RECHECK');
  });
  await test('IT-V2-19','REQUIRE_REVIEW persists an incident and releases no content',async()=>{
    const r=await post('OUTPUT_REVIEW_CASE');assert.equal(r.status,409,r.body);assert.ok(!r.body.includes('SYNTHETIC_REVIEW_MARKER'));await awaitFinalized(r.id);
    const row=(await db.query('select state,trace_id from gateway_requests r join lateral (select r.auth_context->\'context\'->>\'traceId\' as trace_id) a on true where r.id=$1',[r.id])).rows[0];assert.equal(row.state,'REVIEW_REQUIRED');
    const incidents=(await db.query('select id from security_incidents where tenant_id=$1 and application_id=$2 and trace_id=$3',[fixture.tenantId,fixture.applicationId,row.trace_id])).rows;assert.equal(incidents.length,1);
    assert.equal((await db.query('select count(*)::int as n from gateway_execution_events where request_id=$1 and kind=\'WRITE_ACCEPTED\'',[r.id])).rows[0].n,0);
  });
  await test('IT-V2-20','WARN permits inspected text and records the actual warning action',async()=>{
    const r=await post('OUTPUT_WARN_CASE');assert.equal(r.status,200,r.body);assert.equal(r.headers.get('x-guard-output-action'),'WARN');assert.ok(r.body.includes('SYNTHETIC_WARN_MARKER'));await awaitFinalized(r.id);
    assert.equal((await db.query('select actual_action from gateway_execution_events where request_id=$1 and kind=\'WRITE_ACCEPTED\'',[r.id])).rows[0].actual_action,'WARN');
  });
  await test('IT-V2-21','node load failure during upstream wait prevents release',async()=>{
    const id=randomUUID(),before=(await calls()).length,pending=post('DELAY_CASE_NODE',{id});
    for(let i=0;i<30&&(await calls()).length===before;i++)await sleep(100);
    assert.ok((await calls()).length>before);
    await db.query('update gateway_node_acks set state=\'FAILED\' where snapshot_id=(select snapshot_id from gateway_requests where id=$1)',[id]);
    const r=await pending;assert.equal(r.status,503,r.body);assert.match(r.body,/NODE_SNAPSHOT_NOT_LOADED/);assert.ok(!r.body.includes('模拟模型答复'));
  });
  await test('IT-V2-22','client cancellation persists termination without output release',async()=>{
    const id=randomUUID(),controller=new AbortController(),before=(await calls()).length;
    const pending=post('DELAY_CASE_CANCEL',{id,signal:controller.signal}).then(()=>{throw new Error('unexpected completed response');},()=>undefined);
    for(let i=0;i<30&&(await calls()).length===before;i++)await sleep(100);
    assert.ok((await calls()).length>before);controller.abort();await pending;await awaitFinalized(id);
    const row=(await db.query('select state from gateway_requests where id=$1',[id])).rows[0];assert.equal(row.state,'UPSTREAM_OUTCOME_UNKNOWN');
    assert.equal((await db.query('select count(*)::int as n from gateway_execution_events where request_id=$1 and kind=\'WRITE_ACCEPTED\'',[id])).rows[0].n,0);
  });
  await test('IT-V2-23','public proxy requires a trusted TLS client certificate',async()=>{
    const before=(await calls()).length;
    await assert.rejects(new Promise((resolve,reject)=>{
      const request=https.request('https://127.0.0.1:58087/v1/chat/completions',{ca:tls.ca,method:'POST',headers:{authorization:'Bearer '+fixture.apiKey},signal:AbortSignal.timeout(5000)},response=>{response.resume();resolve();});
      request.on('error',reject);request.end('{}');
    }));
    assert.equal((await calls()).length,before);
  });
  await test('IT-V2-24','WebSocket releases approved frames with one durable completion',async()=>{
    const r=await websocket('WS_NORMAL');assert.equal(r.code,1000);assert.equal(r.frames.filter(f=>f==='[DONE]').length,1);assert.ok(r.frames.filter(frame=>frame!=='[DONE]').map(frame=>JSON.parse(frame)).flatMap(frame=>frame.choices??[]).map(choice=>choice.delta?.content??'').join('').includes('真实检测'));await awaitFinalized(r.id);
    assert.equal((await db.query("select state from gateway_requests where id=$1",[r.id])).rows[0].state,'COMPLETED');
  });
  await test('IT-V2-25','WebSocket blocked output closes without releasing model frames',async()=>{
    const r=await websocket('OUTPUT_BLOCK_CASE');assert.equal(r.code,1008);assert.deepEqual(r.frames,[]);await awaitFinalized(r.id);
  });
  await test('IT-V2-26','WebSocket credential rejection causes no upstream call',async()=>{
    const before=(await calls()).length;const r=await websocket('WS_INVALID',{headers:{authorization:'Bearer invalid'}});assert.equal(r.code,1008);assert.deepEqual(r.frames,[]);assert.equal((await calls()).length,before);
  });
  await test('IT-V2-27','real console BFF binds current user and returns only masked gateway output',async()=>{
    const r=await consolePost('OUTPUT_PHONE_CASE');assert.equal(r.status,200,r.body);assert.ok(!r.body.includes('13800138000'));
    const result=JSON.parse(r.body),consoleFixture=JSON.parse(readFileSync(path.join(directory,'console-fixture.json'),'utf8'));assert.equal(result.data.gateway.outputAction,'MASK');await awaitFinalized(result.data.gateway.requestId);
    const stored=(await db.query('select auth_context from gateway_requests where id=$1',[result.data.gateway.requestId])).rows[0].auth_context;
    assert.equal(stored.context.subjectId,consoleFixture.userId);assert.equal(stored.context.credentialId,undefined);assert.equal(stored.context.tenantId,fixture.tenantId);
  });
  await test('IT-V2-28','console rejects body role injection and missing CSRF before model call',async()=>{
    const before=(await calls()).length;const injected=await consolePost('NORMAL_CASE',{body:{role:'SYSTEM_ADMIN'}});assert.equal(injected.status,400,injected.body);
    const csrf=await consolePost('NORMAL_CASE',{headers:{'x-csrf-token':''}});assert.equal(csrf.status,403,csrf.body);assert.equal((await calls()).length,before);
  });
  await test('IT-V2-29','disabled console user cannot reuse a still-signed session',async()=>{
    const c=JSON.parse(readFileSync(path.join(directory,'console-fixture.json'),'utf8')),before=(await calls()).length;
    await db.query("update users set status='disabled' where id=$1",[c.userId]);
    try { const r=await consolePost('NORMAL_CASE');assert.equal(r.status,401,r.body);assert.equal((await calls()).length,before); }
    finally { await db.query("update users set status='active' where id=$1",[c.userId]); }
  });
  await test('IT-V2-12' ,'authorization revocation during upstream wait stops release',async()=>{
    const before=(await calls()).length; const pending=post('DELAY_CASE_REVOKE');
    for(let i=0;i<30&&(await calls()).length===before;i++) await sleep(100);
    assert.ok((await calls()).length>before,'upstream call did not start');
    await db.query('update applications set auth_version=auth_version+1 where id=$1',[fixture.applicationId]);
    const r=await pending; assert.equal(r.status,401,r.body); assert.ok(!r.body.includes('模拟模型答复'));
  });
} finally {
  await db.end();
  const report={schemaVersion:'2.0',capturedAt:new Date().toISOString(),status:results.length===29&&results.every(r=>r.status==='PASS')?'PASS':'FAIL',environment:{java:'real Spring WebFlux',control:'real Next.js and GuardEngine',storage:'isolated PostgreSQL',internalTransport:'mutual TLS',proxyTransport:'required mutual TLS',model:'synthetic capture service'},claims:{realModelQuality:false,targetHardwarePerformance:false,soak24Hours:false,externalIntegration:false},results};
  writeFileSync(path.join(directory,'e2e-evidence.json'),JSON.stringify(report,null,2));
  if(report.status!=='PASS')process.exitCode=1;
}
