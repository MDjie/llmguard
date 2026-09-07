import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const directory=path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const env=JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
const fixture=JSON.parse(readFileSync(path.join(directory,'fixture.json'),'utf8'));
const url=new URL(env.PGDATABASE_URL);
if(url.hostname!=='127.0.0.1'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_DATABASE_REQUIRED');
const db=new pg.Client({connectionString:env.PGDATABASE_URL,ssl:false}),results=[];
await db.connect();
async function check(name,fn){await db.query('BEGIN');try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(error){results.push({name,status:'FAIL',code:error.code??'ASSERTION'});throw error;}finally{await db.query('ROLLBACK');}}
async function denied(query,params,code='23503'){await assert.rejects(db.query(query,params),error=>error.code===code);}
try{
  const migration=readFileSync(path.resolve('drizzle/0048_gateway_execution_references.sql'),'utf8');
  for(let repeat=0;repeat<2;repeat++){await db.query('BEGIN');try{await db.query(migration);await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}}
  results.push({name:'0048 applies twice without changing existing records',status:'PASS'});
  const snapshots=(await db.query('select id from gateway_runtime_snapshots where tenant_id=$1 and application_id=$2 order by generation desc limit 2',[fixture.tenantId,fixture.applicationId])).rows;
  const request=(await db.query("select id,snapshot_id from gateway_requests where tenant_id=$1 and application_id=$2 and state='COMPLETED' order by created_at desc limit 1",[fixture.tenantId,fixture.applicationId])).rows[0];
  assert.ok(request&&snapshots.length===2,'Run the real gateway integration suite first');
  const otherSnapshot=snapshots.find(row=>row.id!==request.snapshot_id).id;
  const event=(await db.query("select id from gateway_execution_events where request_id=$1 and kind='WRITE_ACCEPTED' limit 1",[request.id])).rows[0];
  const otherStep=(await db.query('select id from gateway_steps where tenant_id=$1 and application_id=$2 and request_id<>$3 order by created_at desc limit 1',[fixture.tenantId,fixture.applicationId,request.id])).rows[0];
  await check('snapshot manifest is immutable',()=>denied("update gateway_runtime_snapshots set digest=repeat('0',64) where id=$1",[request.snapshot_id],'P0001'));
  await check('revoked snapshots cannot reactivate',async()=>{await db.query("update gateway_runtime_snapshots set state='REVOKED' where id=$1",[request.snapshot_id]);await denied("update gateway_runtime_snapshots set state='ACTIVE' where id=$1",[request.snapshot_id],'P0001');});
  await check('request cannot reference a snapshot from another application',async()=>{
    const app=randomUUID();await db.query("insert into applications(id,tenant_id,code,name) values($1,$2,$1,'隔离外键测试')",[app,fixture.tenantId]);
    await denied("insert into gateway_requests(id,tenant_id,application_id,idempotency_key,request_hmac,snapshot_id,subject_id,auth_context,expires_at) values($1,$2,$3,$1,repeat('0',64),$4,'test','{}',now()+interval '1 minute')",[randomUUID(),fixture.tenantId,app,request.snapshot_id]);
  });
  await check('snapshot cannot reference another application policy bundle',async()=>{
    const app=randomUUID();await db.query("insert into applications(id,tenant_id,code,name) values($1,$2,$1,'隔离制品外键测试')",[app,fixture.tenantId]);
    await denied("insert into gateway_runtime_snapshots(id,tenant_id,application_id,generation,bundle_id,manifest,digest,signature,key_id,valid_until) select $1,tenant_id,$2,1,bundle_id,manifest,digest,signature,key_id,valid_until from gateway_runtime_snapshots where id=$3",[randomUUID(),app,request.snapshot_id]);
  });
  await check('execution event snapshot must match its business request',()=>denied('update gateway_execution_events set snapshot_id=$1 where id=$2',[otherSnapshot,event.id]));
  await check('execution event step must belong to its business request',()=>denied('update gateway_execution_events set step_id=$1 where id=$2',[otherStep.id,event.id]));
  await check('idempotency key cannot reserve a second business request',()=>denied('insert into gateway_requests(id,tenant_id,application_id,idempotency_key,request_hmac,snapshot_id,subject_id,auth_context,expires_at) select $1,tenant_id,application_id,idempotency_key,request_hmac,snapshot_id,subject_id,auth_context,expires_at from gateway_requests where id=$2',[randomUUID(),request.id],'23505'));
  await check('session lease permits only one unfinished business request',async()=>{
    const session=randomUUID();
    const query="insert into gateway_requests(id,tenant_id,application_id,idempotency_key,request_hmac,snapshot_id,subject_id,auth_context,expires_at,session_id) select $1,tenant_id,application_id,$1,request_hmac,snapshot_id,subject_id,auth_context,now()+interval '1 minute',$3 from gateway_requests where id=$2";
    await db.query(query,[randomUUID(),request.id,session]);await denied(query,[randomUUID(),request.id,session],'23505');
  });
  await check('execution sequence cannot be acknowledged twice',()=>denied('insert into gateway_execution_events(id,tenant_id,application_id,request_id,event_seq,kind,snapshot_id,event_hmac) select $1,tenant_id,application_id,request_id,event_seq,kind,snapshot_id,event_hmac from gateway_execution_events where id=$2',[randomUUID(),event.id],'23505'));
}finally{
  await db.end();
  writeFileSync(path.join(directory,'storage-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),status:results.length===10&&results.every(row=>row.status==='PASS')?'PASS':'FAIL',isolatedDatabase:true,mutationTestsRolledBack:true,results},null,2));
}
