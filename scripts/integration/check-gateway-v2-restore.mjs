import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';

const root=path.resolve(import.meta.dirname,'../..'),directory=path.join(root,'.artifact-build/upgrade-implementation-20260907/environment');
const environment=JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
const url=new URL(environment.PGDATABASE_URL),container='guardllm-upgrade-v2-db-20260907';
if(url.hostname!=='127.0.0.1'||url.port!=='55447'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_DATABASE_REQUIRED');
function docker(args){const result=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});if(result.status!==0)throw new Error('ISOLATED_DOCKER_OPERATION_FAILED:'+args[0]);return result.stdout;}
const info=JSON.parse(docker(['inspect',container]))[0];if(info.Config.Labels['guardllm.scope']!=='upgrade-v2-integration')throw new Error('ISOLATED_CONTAINER_REQUIRED');
const restoredDatabase='guardllm_integration_gateway_v2_restore_'+Date.now();
const dumpPath=path.join(directory,restoredDatabase+'.dump'),containerDump='/tmp/'+restoredDatabase+'.dump';
const tables=['applications','policy_bundles','gateway_runtime_snapshots','gateway_requests','gateway_steps','gateway_execution_events','gateway_node_acks','gateway_audit_batches','tool_invocations','guard_jobs','gateway_request_resources','gateway_admission_windows','gateway_runtime_publications','gateway_shadow_evaluations','data_deletion_proofs'];
const source=new pg.Client({connectionString:environment.PGDATABASE_URL,ssl:false});await source.connect();
async function fingerprints(client){const result={};for(const table of tables){const row=await client.query(`select count(*)::int as count,md5(coalesce(string_agg(hash,'' order by hash),'')) as digest from (select md5(row_to_json(t)::text) as hash from ${table} t) s`);result[table]=row.rows[0];}return result;}
const started=Date.now(),results=[];let restored;
try{
  const before=await fingerprints(source);
  docker(['exec',container,'pg_dump','-U','gateway_test','-d','guardllm_integration_gateway_v2','-Fc','-f',containerDump]);
  docker(['cp',container+':'+containerDump,dumpPath]);
  docker(['exec',container,'createdb','-U','gateway_test',restoredDatabase]);
  docker(['exec',container,'pg_restore','-U','gateway_test','--no-owner','--no-privileges','--exit-on-error','-d',restoredDatabase,containerDump]);
  const restoreUrl=new URL(environment.PGDATABASE_URL);restoreUrl.pathname='/'+restoredDatabase;
  restored=new pg.Client({connectionString:restoreUrl.toString(),ssl:false});await restored.connect();
  const after=await fingerprints(source);assert.deepEqual(after,before,'Source changed during backup; repeat with a quiescent fixture');assert.deepEqual(await fingerprints(restored),before);
  results.push({name:'isolated backup and restore preserve all fifteen selected table fingerprints',status:'PASS'});
  const migrations=['0047_gateway_execution_runtime.sql','0048_gateway_execution_references.sql','0049_tool_execution_receipts.sql','0050_rag_retrieval_proofs.sql','0051_tool_execution_reconciliation.sql','0052_tool_authority_compensation.sql','0053_guard_job_execution_binding.sql','0054_gateway_audit_batches.sql','0055_gateway_content_retention.sql','0056_gateway_runtime_publications.sql','0057_gateway_request_resources.sql','0058_gateway_shadow_evaluations.sql'];
  for(const file of migrations){const sql=readFileSync(path.join(root,'drizzle',file),'utf8');for(let pass=0;pass<2;pass++){await restored.query('BEGIN');try{await restored.query(sql);await restored.query('COMMIT');}catch(error){await restored.query('ROLLBACK');throw error;}}}
  assert.deepEqual(await fingerprints(restored),before);results.push({name:'upgrade migrations can run twice after restore without changing existing data',status:'PASS'});
  assert.ok((await restored.query('select id,name from applications limit 1')).rows.length);results.push({name:'legacy application reader remains compatible after expanded schema restore',status:'PASS'});
  const sample=(await restored.query('select id from gateway_execution_events limit 1')).rows[0];assert.ok(sample);await assert.rejects(restored.query("update gateway_execution_events set reason_code='restore-fixture-forged' where id=$1",[sample.id]));results.push({name:'restored evidence immutability trigger still rejects tampering',status:'PASS'});
  const report={capturedAt:new Date().toISOString(),status:'PASS',isolatedDatabase:true,productionRecoveryAcceptance:false,durationSeconds:(Date.now()-started)/1000,
    restoredDatabase,backupSha256:createHash('sha256').update(readFileSync(dumpPath)).digest('hex'),migrations,fingerprints:before,results};
  writeFileSync(path.join(directory,'restore-evidence.json'),JSON.stringify(report,null,2));
  console.log('PASS isolated dump/restore, fifteen-table fingerprints, repeated migrations, legacy reader and immutable evidence');
}finally{await restored?.end();await source.end();}
