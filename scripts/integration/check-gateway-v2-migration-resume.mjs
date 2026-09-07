import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
const directory=path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const environment=JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8')),restore=JSON.parse(readFileSync(path.join(directory,'restore-evidence.json'),'utf8'));
const url=new URL(environment.PGDATABASE_URL);if(url.hostname!=='127.0.0.1'||url.port!=='55447'||url.pathname!=='/guardllm_integration_gateway_v2'||!/^guardllm_integration_gateway_v2_restore_\d+$/.test(restore.restoredDatabase))throw new Error('ISOLATED_RESTORED_DATABASE_REQUIRED');
url.pathname='/'+restore.restoredDatabase;const directoryRun=path.join(directory,'migration-resume-'+Date.now());mkdirSync(directoryRun);
const config=path.join(directoryRun,'private-config.json'),plan=path.join(directoryRun,'plan.json');writeFileSync(config,JSON.stringify({databaseUrl:url.toString()}));
const db=new pg.Client({connectionString:url.toString(),ssl:false,application_name:'guardllm-isolated-migration-fault'});await db.connect();
async function command(args,expected=0){let stderr='';const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/release/gateway-v2-migrate.mjs','--config',config,...args],{windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',chunk=>{if(stderr.length<4096)stderr+=chunk.toString();});const timer=setTimeout(()=>{child.kill();reject(new Error('MIGRATION_TEST_TIMEOUT'));},20000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);resolve(code);});});if(expected===0)assert.equal(code,0,stderr);else assert.notEqual(code,0);return stderr;}
const results=[];
try{
  assert.equal((await db.query("select to_regclass('public.guardllm_gateway_upgrade_migrations') as name")).rows[0].name,null,'Use a fresh isolated restore with no migration runner ledger');
  await command(['--mode','plan','--from','55','--output',plan]);
  await db.query('BEGIN');await db.query('LOCK TABLE gateway_runtime_publications IN SHARE UPDATE EXCLUSIVE MODE');
  const failed=path.join(directoryRun,'interrupted.json');
  try{assert.match(await command(['--mode','apply','--plan',plan,'--expected-database',restore.restoredDatabase,'--output',failed],1),/MIGRATION_FAILED_RESUMABLE/);}finally{await db.query('ROLLBACK');}
  const interrupted=JSON.parse(readFileSync(failed));assert.equal(interrupted.status,'FAILED_RESUMABLE');assert.equal(interrupted.failedFile,'0056_gateway_runtime_publications.sql');assert.deepEqual(interrupted.outcomes.map(row=>row.file),['0055_gateway_content_retention.sql']);
  assert.deepEqual((await db.query('select file from guardllm_gateway_upgrade_migrations order by file')).rows.map(row=>row.file),['0055_gateway_content_retention.sql']);
  results.push({name:'real lock timeout rolls back only the current migration and preserves preceding checksum commit',status:'PASS'});
  const resumed=path.join(directoryRun,'resumed.json');await command(['--mode','apply','--plan',plan,'--expected-database',restore.restoredDatabase,'--output',resumed]);
  const complete=JSON.parse(readFileSync(resumed));assert.equal(complete.status,'PASS');assert.equal(complete.outcomes[0].state,'ALREADY_APPLIED');assert.ok(complete.outcomes.slice(1).every(row=>row.state==='APPLIED'));assert.equal(complete.outcomes.length,4);
  results.push({name:'unchanged plan resumes after lock release and applies remaining migrations exactly once',status:'PASS'});
  const repeated=path.join(directoryRun,'repeated.json');await command(['--mode','apply','--plan',plan,'--expected-database',restore.restoredDatabase,'--output',repeated]);assert.ok(JSON.parse(readFileSync(repeated)).outcomes.every(row=>row.state==='ALREADY_APPLIED'));
  results.push({name:'second resume performs no migration again and preserves legacy application reads',status:'PASS'});assert.ok((await db.query('select id,name from applications limit 1')).rows.length);
  console.log('PASS 3 isolated actual migration interruption/resume checks');
}finally{await db.end();writeFileSync(path.join(directory,'migration-resume-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),status:results.length===3?'PASS':'FAIL',isolatedRestoredDatabase:true,productionOnlineDdlTested:false,results},null,2));}
