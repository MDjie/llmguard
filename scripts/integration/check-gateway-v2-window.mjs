import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import pg from 'pg';
const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const env = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
const url = new URL(env.PGDATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
const db = new pg.Client({ connectionString: env.PGDATABASE_URL, ssl: false }); await db.connect();
const tls = Object.fromEntries([['ca','ca.crt'],['cert','client.crt'],['key','client.key']].map(([key,file]) => [key,readFileSync(path.join(directory,'tls',file))]));
const results = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const qualificationFile = path.join(directory, 'window-qualifications.json'), qualification = readFileSync(qualificationFile, 'utf8');
function modelState(tag, method = 'GET') {
  return new Promise((resolve,reject) => {
    const req = https.request('https://127.0.0.1:58088/test/windows?tag='+encodeURIComponent(tag),{...tls,method,signal:AbortSignal.timeout(5000)},response => {
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)));}catch(error){reject(error);}});response.on('error',reject);
    });req.on('error',reject);req.end();
  });
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) { return value && typeof value==='object' ? Array.isArray(value) ? '['+value.map(canonical).join(',')+']' : '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}' : JSON.stringify(value); }
async function internal(operation, body) {
  const raw=JSON.stringify(body), pathname='/api/internal/gateway/'+operation, stamp=String(Date.now()), nonce=randomUUID();
  const keys=JSON.parse(env.GATEWAY_WORKLOAD_KEYS_JSON ?? readFileSync(env.GATEWAY_WORKLOAD_KEYS_FILE,'utf8')), identity=keys[env.GATEWAY_NODE_ID];
  const signature=createHmac('sha256',identity.secret).update(['POST',pathname,stamp,nonce,hash(raw)].join('\n')).digest('hex');
  return new Promise((resolve,reject)=>{
    const req=https.request('https://127.0.0.1:5107'+pathname,{...tls,method:'POST',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json','x-guard-workload':env.GATEWAY_NODE_ID,'x-guard-workload-time':stamp,'x-guard-workload-nonce':nonce,'x-guard-workload-signature':signature}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks))});}catch(error){reject(error);}});response.on('error',reject);
    });req.on('error',reject);req.end(raw);
  });
}
async function stream(kind, options = {}) {
  const id = randomUUID(), tag = kind + '_' + id, session = randomUUID();
  return new Promise((resolve,reject) => {
    let first, firstError, firstReceived = false, aborted = false;
    const req = https.request('https://127.0.0.1:58087/v1/chat/completions',{...tls,method:'POST',signal:AbortSignal.timeout(65000),headers:{'content-type':'application/json',authorization:'Bearer '+fixture.apiKey,'x-request-id':id,'idempotency-key':id,'x-session-id':session}},response => {
      const chunks=[];
      const finish = async () => { await first; if(firstError)reject(firstError);else resolve({id,session,status:response.statusCode,body:Buffer.concat(chunks).toString('utf8'),firstReceived,aborted}); };
      response.on('data',chunk=>{
        chunks.push(chunk);
        if (!first && chunk.toString('utf8').includes('chat.completion.chunk')) {
          firstReceived = true;
          first = (async()=>{
            const state = await modelState(tag); assert.equal(state.finished,false,'first approved bytes must precede upstream completion');
            const intents = (await db.query("select kind from gateway_execution_events where request_id=$1 and kind='RELEASE_INTENT'",[id])).rows;
            assert.ok(intents.length>0,'release intent must exist before client observes bytes');
            if(options.check) await options.check(id);
            if(options.revoke) writeFileSync(qualificationFile,'[]');
            if(options.cancel) {aborted=true;req.destroy();response.destroy();}
          })().catch(error=>{firstError=error;}).finally(()=>modelState(tag,'POST'));
        }
      });
      response.on('end',finish); response.on('error',error=>{if(!aborted)reject(error);}); response.on('close',()=>{if(aborted)finish();});
    });req.on('error',error=>{if(!aborted)reject(error);});req.end(JSON.stringify({model:'test',messages:[{role:'user',content:tag}],stream:true}));
  });
}
async function finalized(id) {
  for(let i=0;i<100;i++) { const row=(await db.query('select state,session_finalized from gateway_requests where id=$1',[id])).rows[0];if(row?.session_finalized)return row;await sleep(100); }
  throw new Error('WINDOW_FINALIZATION_TIMEOUT');
}
function output(body) {
  return body.split('\n\n').flatMap(frame=>{const line=frame.split('\n').find(value=>value.startsWith('data: '));if(!line||line==='data: [DONE]')return[];const event=JSON.parse(line.slice(6));return(event.choices??[]).map(choice=>choice.delta?.content??'');}).join('');
}
async function writes(id) {
  const events=(await db.query("select event_seq,kind,range_start,range_end,step_id,payload_hmac from gateway_execution_events where request_id=$1 order by event_seq",[id])).rows;
  let cursor=0;
  for(const event of events.filter(event=>event.kind==='WRITE_ACCEPTED')){
    assert.equal(event.range_start,cursor);assert.ok(event.range_end>=cursor);cursor=event.range_end;
    const intent=events.find(item=>item.event_seq===event.event_seq-1);assert.equal(intent.kind,'RELEASE_INTENT');assert.equal(intent.step_id,event.step_id);assert.equal(intent.payload_hmac,event.payload_hmac);assert.equal(intent.range_start,event.range_start);assert.equal(intent.range_end,event.range_end);
  }
  return{events,cursor};
}
async function test(id,name,fn) {
  try{await fn();results.push({id,name,status:'PASS'});console.log(id+' PASS '+name);}catch(error){results.push({id,name,status:'FAIL',detail:error.message.slice(0,400)});console.log(id+' FAIL '+name+' '+error.message.slice(0,400));}
  finally{writeFileSync(qualificationFile,qualification);}
}
try{
  await test('IT-WINDOW-01','real incremental release before upstream completion, contiguous durable writes and one session commit',async()=>{
    const r=await stream('WINDOW_NORMAL');assert.equal(r.status,200,r.body);assert.ok(r.firstReceived);assert.equal(output(r.body),'正常答复与公开信息。'.repeat(800));assert.equal(r.body.split('[DONE]').length-1,1);
    assert.equal((await finalized(r.id)).state,'COMPLETED');const proof=await writes(r.id);assert.equal(proof.cursor,8000);assert.ok(proof.events.filter(event=>event.kind==='WRITE_ACCEPTED').length>=7);
    const steps=(await db.query("select stream_seq from gateway_steps where request_id=$1 and stage='OUTPUT_CHUNK' order by stream_seq",[r.id])).rows;assert.deepEqual(steps.map(step=>step.stream_seq),steps.map((_,index)=>index));
    const receipts=(await db.query('select direction from guard_session_request_receipts where session_id=$1 and request_id=$2 order by direction',[r.session,r.id])).rows;assert.deepEqual(receipts.map(row=>row.direction),['INPUT','OUTPUT_COMPLETE']);
  });
  for(const [id,kind,reason] of [['02','WINDOW_BLOCK','GUARD_OUTPUT_BLOCKED'],['03','WINDOW_MASK','WINDOW_TRANSFORM_REQUIRES_FULL_BUFFER'],['04','WINDOW_TRUNCATED','SSE_TRUNCATED'],['05','WINDOW_TOOL','WINDOW_TEXT_ONLY_REQUIRED']]) await test('IT-WINDOW-'+id,'partial termination '+kind,async()=>{
    const r=await stream(kind);assert.equal(r.status,200,r.body);assert.ok(r.firstReceived);assert.ok(!r.body.includes('[DONE]'));assert.match(r.body,new RegExp(reason));assert.ok(!r.body.includes('SYNTHETIC_BLOCK_MARKER'));assert.ok(!r.body.includes('13800138000'));assert.ok(!r.body.includes('"unsafe"'));
    const final=await finalized(r.id);assert.notEqual(final.state,'COMPLETED');const proof=await writes(r.id);assert.ok(proof.cursor>0);assert.equal(proof.cursor,output(r.body).length);assert.ok(proof.cursor<8000);
  });
  await test('IT-WINDOW-06','operator qualification revocation stops in-flight release',async()=>{
    const r=await stream('WINDOW_REVOKED',{revoke:true});assert.ok(r.firstReceived);assert.ok(!r.body.includes('[DONE]'));assert.match(r.body,/STREAM_QUALIFICATION_REVOKED/);await finalized(r.id);assert.equal((await writes(r.id)).cursor,1024);
  });
  await test('IT-WINDOW-08','step replay, changed content, stale range, premature completion and privilege widening are rejected',async()=>{
    const r=await stream('WINDOW_REPLAY',{check:async(id)=>{
      let request; for(let attempt=0;attempt<30;attempt++){request=(await db.query('select auth_context,last_event_seq,state from gateway_requests where id=$1',[id])).rows[0];if(request.state==='WRITTEN')break;await sleep(50);}
      assert.equal(request.state,'WRITTEN');const auth=request.auth_context, context=auth.context;
      const step=(await db.query("select id,decision_id from gateway_steps where request_id=$1 and stage='OUTPUT_CHUNK' and stream_seq=0",[id])).rows[0];
      const text='正常答复与公开信息。'.repeat(800).slice(0,1280), contentPath='/choices/0/message/content';
      const segments=[{segmentId:hash(contentPath).slice(0,32),contentPath,role:'assistant',text,sourceType:'MODEL',sourceDigest:hash(text)}];
      const body={contractVersion:'2.0',auth,businessRequestId:id,stepId:step.id,traceId:context.traceId,stage:'OUTPUT_CHUNK',streamSeq:0,attemptKind:'INITIAL',snapshotId:context.policy.snapshotId,deadline:context.deadline,segments,window:{contextStart:0,releaseStart:0,releaseEnd:1024,final:false}};
      const replay=await internal('evaluate',body);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.decisionId,step.decision_id);
      const changed='X'+text.slice(1);const conflict=await internal('evaluate',{...body,segments:[{...segments[0],text:changed,sourceDigest:hash(changed)}]});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'STEP_CONTENT_CONFLICT');
      const releaseSegments=[{...segments[0],text:text.slice(0,1024),sourceDigest:hash(text.slice(0,1024))}];
      const event={eventSeq:3,kind:'RELEASE_INTENT',snapshotId:context.policy.snapshotId,stepId:step.id,decisionId:step.decision_id,actualAction:'ALLOW',rangeStart:0,rangeEnd:1024,payloadDigest:hash(canonical(releaseSegments))};
      const events={contractVersion:'2.0',auth,events:[event]};
      assert.equal((await internal('events',events)).status,200);
      const stale=await internal('events',{...events,events:[{...event,eventSeq:5}]});assert.equal(stale.status,409);assert.equal(stale.body.code,'WINDOW_RELEASE_NOT_CONTIGUOUS');
      const premature=await internal('events',{...events,events:[{eventSeq:5,kind:'COMPLETED',snapshotId:context.policy.snapshotId}]});assert.equal(premature.status,409);assert.equal(premature.body.code,'WINDOW_FINAL_WRITE_REQUIRED');
      const widened=await internal('events',{...events,terminalReconciliation:true});assert.equal(widened.status,403);assert.equal(widened.body.code,'TERMINAL_RECONCILIATION_ONLY');
    }});
    assert.equal(r.status,200);assert.equal((await finalized(r.id)).state,'COMPLETED');
    const request=(await db.query('select auth_context,last_event_seq from gateway_requests where id=$1',[r.id])).rows[0];
    const settled=await internal('events',{contractVersion:'2.0',auth:request.auth_context,terminalReconciliation:true,events:[{eventSeq:1,kind:'TERMINATED',snapshotId:request.auth_context.context.policy.snapshotId,reasonCode:'CLIENT_CANCELLED'}]});
    assert.equal(settled.status,200);assert.equal(settled.body.state,'COMPLETED');assert.equal(settled.body.acceptedThrough,request.last_event_seq);
  });
  await test('IT-WINDOW-07','client disconnect preserves partial write evidence and releases request lease',async()=>{
    const r=await stream('WINDOW_CANCELLED',{cancel:true});assert.ok(r.firstReceived);assert.ok(r.aborted);const final=await finalized(r.id);assert.notEqual(final.state,'COMPLETED');const proof=await writes(r.id);assert.ok(proof.cursor<=1024);assert.ok(proof.events.some(event=>event.kind==='TERMINATED'));
  });
} finally {
  writeFileSync(qualificationFile,qualification);await db.end();
  const report={schemaVersion:'1.0',runId:randomUUID(),createdAt:new Date().toISOString(),environment:'isolated-local-Java-Node-PostgreSQL-mTLS-synthetic-upstream',evidenceClass:'ENGINEERING',productionQualityProven:false,passed:results.filter(result=>result.status==='PASS').length,failed:results.filter(result=>result.status==='FAIL').length,results};
  writeFileSync(path.resolve('.artifact-build/upgrade-implementation-20260907/window-evidence.json'),JSON.stringify(report,null,2)+'\n');if(report.failed)process.exitCode=1;
}
