import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { db, closeDatabaseConnection } from '../../../src/storage/database/shared/db';
import { detectionSessions, detectionRecords, agentTraces, judgeModelInvocations, testCases } from '../../../src/storage/database/shared/schema';
async function main() {
 const out=process.env.COMPREHENSIVE_RUN_DIR!; const f=JSON.parse(readFileSync(out+'/fixture.private.json','utf8')) as {tenantId:string;applicationId:string;policyId:string;userId:string};
 const scope={tenantId:f.tenantId,applicationId:f.applicationId}; const sessionId=randomUUID(),recordId=randomUUID();
 await db.transaction(async tx=>{
  await tx.insert(detectionSessions).values({...scope,id:sessionId,policyId:f.policyId,userId:f.userId,finalAction:'allow',userPrompt:'合成审计测试数据'});
  await tx.insert(detectionRecords).values({...scope,id:recordId,sessionId,direction:'input',action:'allow'});
  await tx.insert(agentTraces).values([{...scope,recordId,workflowName:'detection',success:true,latencyMs:7},{...scope,recordId,workflowName:'judge',success:false,errorMessage:'SYNTHETIC_TIMEOUT',latencyMs:30},{...scope,workflowName:'legacy-unknown',success:null}]);
  const [row]=await tx.insert(judgeModelInvocations).values({...scope,sessionId,policyId:f.policyId,direction:'input',inputHash:'a'.repeat(64),promptTokens:11,completionTokens:7,totalTokens:18,errorMessage:'SYNTHETIC_ONLY_NO_MODEL_CALLED'}).returning();
  assert.equal(row.inputHash,'a'.repeat(64)); assert.equal(row.totalTokens,18);
  await tx.insert(testCases).values({...scope,title:('中文长标题'.repeat(12)+'UUID_'+randomUUID()+'LONGENGLISH'.repeat(15)).slice(0,195),inputText:'合成移动端布局测试，不代表质量集',category:'normal',expectedAction:'allow'});
  for (const days of [0,6,7,29,30,89,90,179,180,181]) for(const action of ['allow','warn','block','mask','rewrite']) await tx.insert(detectionSessions).values({...scope,policyId:f.policyId,finalAction:action,createdAt:new Date(Date.now()-days*86400000)});
 });
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN'); const schema='upgrade_'+randomUUID().replaceAll('-','');await c.query(`CREATE SCHEMA "${schema}"`);await c.query(`SET LOCAL search_path TO "${schema}"`);
 await c.query(`CREATE TABLE detection_records(id varchar(36) PRIMARY KEY);CREATE TABLE llm_providers(id varchar(36) PRIMARY KEY);CREATE TABLE agent_traces(id varchar(36) PRIMARY KEY,session_id varchar(36) NOT NULL,trace_type text NOT NULL,trace_data jsonb NOT NULL,created_at timestamptz DEFAULT now());CREATE TABLE judge_model_invocations(id varchar(36) PRIMARY KEY);INSERT INTO agent_traces(id,session_id,trace_type,trace_data) VALUES ('old','historical-session','legacy','{"kept":true}');`);
 const migration=readFileSync('drizzle/0065_runtime_trace_schema.sql','utf8');await c.query(migration);await c.query(migration);
 const row=(await c.query('select * from agent_traces where id=$1',['old'])).rows[0];assert.equal(row.success,null);assert.equal(row.record_id,null);assert.equal(row.session_id,'historical-session');assert.deepEqual(row.trace_data,{kept:true});
 await c.query(`INSERT INTO agent_traces(id,workflow_name,success) VALUES ('new','failure',false)`);await c.query('ROLLBACK');
 }finally{await c.end();}
 writeFileSync(out+'/trace-fixture.json',JSON.stringify({status:'PASS',sessionId,recordId,legacyUpgrade:'PASS',idempotentUpgrade:'PASS',unknownOutcomePreserved:true,realTraceWrites:3,judgePersistence:'PASS',externalModelCalled:false},null,2));console.log('TRACE_UPGRADE_AND_REAL_WRITES_PASS');
}
main().finally(closeDatabaseConnection).catch(e=>{console.error(e instanceof Error?String(e.cause instanceof Error ? e.cause.message : e.message).slice(0,300):'TRACE_FIXTURE_FAILED');process.exitCode=1;});
