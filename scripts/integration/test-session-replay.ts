import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import type { GuardDecision, GuardRequest } from '@guardllm/contracts';
import { options, required, writeArtifact } from '../content-safety/optimization-cli';

async function main() {
  const args=options(['out','apply-migration']);const out=required(args.out,'out');
  const url=new URL(process.env.INTEGRATION_DATABASE_URL ?? '');
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !/^\/guardllm_integration[a-z0-9_]*$/u.test(url.pathname))
    throw new Error('ISOLATED_LOCAL_INTEGRATION_DATABASE_REQUIRED');
  process.env.PGDATABASE_URL=url.href;process.env.DATABASE_SSL_MODE='disable';
  process.env.DATABASE_PLAINTEXT_ALLOWED_HOSTS=url.hostname;
  process.env.SECRET_MASTER_KEY=randomBytes(32).toString('base64');process.env.SECRET_MASTER_KEY_ID='synthetic-replay-key';
  const client=new Client({connectionString:url.href});await client.connect();
  const {closeDatabaseConnection}=await import('../../src/storage/database/shared/db');
  const {readSecureMemorySnapshot,readSecureMemoryReplay,endSecureMemorySession}=await import('../../src/lib/secure-memory');
  const {evaluateWithSessionContext}=await import('../../src/lib/guard-engine-v2/session-context');
  const scope={tenantId:randomUUID(),applicationId:randomUUID()};const sessionId=randomUUID();const checks:string[]=[];
  let modelCalls=0;
  const engine={async evaluate(request:GuardRequest):Promise<GuardDecision> {
    modelCalls++;
    const turnMarker=request.content.text ?? '';
    return {contractVersion:'1.0',decisionId:randomUUID(),traceId:request.context.traceId,bundleId:request.context.policyBundleId,
      action:'ALLOW',riskLevel:'NONE',latencyMs:1,policyPath:['synthetic-test-only'],degradationReasons:[],
      observations:turnMarker.includes('CANDIDATE') ? [{detectorId:'lexical-test',detectorVersion:'1',riskType:'self_harm',score:0.9,
        severity:'HIGH',evidence:[],status:'MATCH',decisionRole:'CANDIDATE'}] : []};
  }};
  const request=(id:string,text:string):GuardRequest=>({contractVersion:'1.0',context:{...scope,sessionId,
    requestId:id,traceId:'synthetic-trace-0001',policyBundleId:'synthetic-policy',direction:'INPUT',
    absoluteDeadlineEpochMs:Date.now()+60000},content:{text}});
  const run=(input:GuardRequest)=>evaluateWithSessionContext(engine,input,scope);
  try {
    if(args['apply-migration']==='yes')await client.query(await readFile('drizzle/0043_session_request_receipts.sql','utf8'));
    await client.query('insert into tenants(id,code,name) values($1,$2,$3)',[scope.tenantId,'replay-'+scope.tenantId,'Synthetic replay integration']);
    await client.query('insert into applications(id,tenant_id,code,name) values($1,$2,$3,$4)',[scope.applicationId,scope.tenantId,'test','Synthetic application']);
    const first=request('request-first','CANDIDATE marker only');
    const initial=await Promise.all([run(first),run(first)]);
    assert.equal(initial[0].decisionId,initial[1].decisionId);
    let snapshot=await readSecureMemorySnapshot(scope,sessionId);
    assert.equal(snapshot.turnCount,1);assert.equal(snapshot.lastEventSequence,1);assert.equal(snapshot.riskLedger.length,0);
    checks.push('simultaneous_first_request_commits_one_event_and_one_decision');
    const before=modelCalls;
    const retry=await run({...first,context:{...first.context,traceId:'synthetic-refreshed-trace',absoluteDeadlineEpochMs:Date.now()+90000}});
    assert.equal(retry.decisionId,initial[0].decisionId);assert.equal(modelCalls,before);
    checks.push('same_content_retry_refreshes_deadline_without_model_call_or_risk_inflation');
    await run(request('request-second','ordinary second turn'));
    await run(request('request-third','ordinary third turn'));
    assert.equal((await run(first)).decisionId,initial[0].decisionId);
    snapshot=await readSecureMemorySnapshot(scope,sessionId);
    assert.equal(snapshot.turnCount,3);assert.equal(snapshot.stateVersion,3);assert.equal(snapshot.riskLedger.length,0);
    checks.push('old_request_replay_after_three_turns_does_not_append_or_confirm_candidates');
    await assert.rejects(run({...first,content:{text:'changed body'}}),{code:'SECURE_MEMORY_REQUEST_CONFLICT'});
    await assert.rejects(run({...first,context:{...first.context,policyBundleId:'different-policy'}}),{code:'SECURE_MEMORY_REQUEST_CONFLICT'});
    await assert.rejects(run({...first,context:{...first.context,subjectId:'different-user'}}),{code:'SECURE_MEMORY_REQUEST_CONFLICT'});
    await assert.rejects(readSecureMemoryReplay({...scope,applicationId:randomUUID()},first),/GUARD_SESSION_SCOPE_MISMATCH/);
    checks.push('content_policy_authorization_and_scope_conflicts_rejected');
    const frozen=await readSecureMemorySnapshot(scope,sessionId);
    const readonlyRequest=request('request-readonly','ordinary compare');
    await Promise.all([
      evaluateWithSessionContext(engine,readonlyRequest,scope,{readOnly:true,snapshot:frozen}),
      evaluateWithSessionContext(engine,{...readonlyRequest,context:{...readonlyRequest.context,policyBundleId:'synthetic-shadow'}},scope,{readOnly:true,snapshot:frozen}),
    ]);
    assert.equal((await readSecureMemorySnapshot(scope,sessionId)).stateVersion,3);
    const receiptCount=await client.query('select count(*)::int as n from guard_session_request_receipts where tenant_id=$1',[scope.tenantId]);
    assert.equal(receiptCount.rows[0].n,3);
    checks.push('shared_readonly_snapshot_does_not_write_events_receipts_or_risk_state');
    const distinct=await Promise.all([run(request('request-fourth','fourth')),run(request('request-fifth','fifth'))]);
    assert.notEqual(distinct[0].decisionId,distinct[1].decisionId);
    assert.equal((await readSecureMemorySnapshot(scope,sessionId)).turnCount,5);
    checks.push('concurrent_distinct_requests_retry_version_conflict_without_lost_turn');
    const stored=await client.query('select decision_envelopes,request_hmac from guard_session_request_receipts where tenant_id=$1 limit 1',[scope.tenantId]);
    assert.ok(!JSON.stringify(stored.rows).includes('CANDIDATE marker only'));
    assert.ok(Array.isArray(stored.rows[0].decision_envelopes));assert.match(stored.rows[0].request_hmac,/^[a-f0-9]{64}$/);
    checks.push('receipt_decisions_encrypted_and_request_fingerprints_keyed');
    await endSecureMemorySession(scope,sessionId);
    await assert.rejects(run(first),{code:'SECURE_MEMORY_RECEIPT_EXPIRED'});
    const ended=await readSecureMemorySnapshot(scope,sessionId);
    assert.equal(ended.hasHistory,false);assert.equal(ended.riskLedger.length,0);
    const endedReceipts=await client.query('select decision_envelopes from guard_session_request_receipts where tenant_id=$1',[scope.tenantId]);
    assert.ok(endedReceipts.rows.every(row=>row.decision_envelopes.length===0));
    checks.push('session_end_expires_replays_erases_receipt_payloads_and_resets_history');
    await writeArtifact(out,{schemaVersion:'1.0',status:'PASS',recordedAt:new Date().toISOString(),database:url.pathname.slice(1),
      fixtureScope:scope,syntheticOnly:true,qualityStatus:'UNVERIFIED',runtimeBusinessDatabaseModified:false,checks});
    console.log(JSON.stringify({status:'PASS',checks:checks.length,report:out}));
  } finally {await closeDatabaseConnection();await client.end();}
}
main().catch(error=>{
  const code=error && typeof error==='object' && 'code' in error ? String(error.code) : 'INTEGRATION_FAILED';
  const locations=error instanceof Error ? error.stack?.split('\n').filter(line=>line.includes('test-session-replay.ts')) : [];
  console.error(JSON.stringify({status:'FAIL',code,locations}));process.exitCode=1;
});
