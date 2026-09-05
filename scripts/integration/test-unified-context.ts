import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { GuardDecision,GuardRequest } from '@guardllm/contracts';
import { options,required,writeArtifact } from '../content-safety/optimization-cli';
async function main(){
  const args=options(['out']);const url=new URL(process.env.INTEGRATION_DATABASE_URL??'');
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/guardllm_integration_v2_[a-z0-9_]+$/u.test(url.pathname))throw new Error('ISOLATED_TEST_ONLY');
  process.env.PGDATABASE_URL=url.href;process.env.DATABASE_SSL_MODE='disable';process.env.DATABASE_PLAINTEXT_ALLOWED_HOSTS=url.hostname;
  process.env.SECRET_MASTER_KEY=randomBytes(32).toString('base64');process.env.SECRET_MASTER_KEY_ID='unified-synthetic';
  const client=new Client({connectionString:url.href,ssl:false});await client.connect();
  const {closeDatabaseConnection}=await import('../../src/storage/database/shared/db');
  const {evaluateWithSessionContext}=await import('../../src/lib/guard-engine-v2/session-context');
  const scope={tenantId:randomUUID(),applicationId:randomUUID()},sessionId=randomUUID(),seen:GuardRequest[]=[];
  const engine={contextEvaluationMode:'unified-v1' as const,async evaluate(request:GuardRequest):Promise<GuardDecision>{
    seen.push(request);return{contractVersion:'1.0',decisionId:randomUUID(),traceId:request.context.traceId,bundleId:request.context.policyBundleId,
      action:'ALLOW',riskLevel:'NONE',observations:[],policyPath:['synthetic'],latencyMs:1,degradationReasons:[]};}};
  const request=(id:string,text:string):GuardRequest=>({contractVersion:'1.0',context:{...scope,sessionId,requestId:id,traceId:'synthetic-unified-trace',policyBundleId:'test-only',direction:'INPUT',absoluteDeadlineEpochMs:Date.now()+60000},content:{text}});
  try{
    await client.query('insert into tenants(id,code,name) values($1,$2,$3)',[scope.tenantId,'unified-'+scope.tenantId,'Synthetic unified test']);
    await client.query('insert into applications(id,tenant_id,code,name) values($1,$2,$3,$4)',[scope.applicationId,scope.tenantId,'test','Synthetic app']);
    await evaluateWithSessionContext(engine,request('first','SYNTHETIC_HISTORY'),scope);
    const second=request('second','SYNTHETIC_CURRENT');const result=await evaluateWithSessionContext(engine,second,scope);
    assert.equal(seen.length,2);assert.ok(seen[1].content.text?.includes('SYNTHETIC_HISTORY'));assert.ok(seen[1].content.text?.endsWith('SYNTHETIC_CURRENT'));
    assert.equal((await evaluateWithSessionContext(engine,second,scope)).decisionId,result.decisionId);assert.equal(seen.length,2);
    assert.ok(result.policyPath.includes('unified-session-context'));
    await writeArtifact(required(args.out,'out'),{status:'PASS',syntheticOnly:true,businessDatabaseModified:false,
      checks:['one_full_evaluation_per_new_turn','history_and_current_evaluated_together','replay_has_zero_extra_model_calls','projected_context_trace_preserved']});
  }finally{await closeDatabaseConnection();await client.end();}
}
main().catch(()=>{console.error('UNIFIED_CONTEXT_INTEGRATION_FAILED');process.exitCode=1;});
