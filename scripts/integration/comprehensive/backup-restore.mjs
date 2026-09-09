import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Client} from 'pg';
const out=resolve(process.argv[2]),within=relative(resolve('.artifact-build'),out);
if(!within||within.startsWith('..')||isAbsolute(within))throw new Error('ISOLATED_RUN_REQUIRED');
const values=JSON.parse(readFileSync(out+'/environment.private.json','utf8')),source=new URL(values.DATABASE_URL);
assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'5438');assert.match(source.pathname,/^\/guardllm_integration_full_\d+$/);
const sourceName=source.pathname.slice(1),database='guardllm_integration_full_'+Date.now(),target=new URL(source),admin=new URL(source);target.pathname='/'+database;admin.pathname='/postgres';
const tables=['artifacts','artifact_parts','guard_jobs','media_evidence_snapshots','content_access_requests','artifact_purge_ledger','artifact_derivatives','rag_sources'];
const checks=[],started=Date.now();const check=id=>{checks.push({id,status:'PASS'});console.log(id+' PASS');};
const run=(args,input)=>{const result=spawnSync('docker',args,{input,windowsHide:true,timeout:120000,maxBuffer:64*1024*1024});if(result.status!==0)throw new Error('ISOLATED_BACKUP_COMMAND_FAILED');return result.stdout;};
async function fingerprint(connectionString){const client=new Client({connectionString});await client.connect();try{const results={};for(const name of tables){const {rows}=await client.query('select count(*)::int as count, md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) order by to_jsonb(t)::text),\'\')) as digest from '+name+' t');results[name]=rows[0];}return results;}finally{await client.end();}}
const resultPath=out+'/backup-restore.json';
try{
 const container='guardllm-multiformat-test-db';
 const port=run(['inspect',container,'--format','{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}']).toString().trim();assert.equal(port,'5438');
 const before=await fingerprint(source.href);assert.ok(before.media_evidence_snapshots.count>0);assert.ok(before.artifact_purge_ledger.count>0);
 const bytes=run(['exec',container,'pg_dump','-U',decodeURIComponent(source.username),'-d',sourceName,'--format=custom','--no-owner','--no-acl']);
 assert.ok(bytes.length>1000);writeFileSync(out+'/database-backup.private.dump',bytes);assert.deepEqual(await fingerprint(source.href),before);check('CONSISTENT_REAL_PG_DUMP_SAVED');
 const client=new Client({connectionString:admin.href});await client.connect();try{await client.query('CREATE DATABASE "'+database+'"');}finally{await client.end();}
 run(['exec','-i',container,'pg_restore','-U',decodeURIComponent(source.username),'-d',database,'--no-owner','--no-acl','--exit-on-error'],bytes);
 assert.deepEqual(await fingerprint(target.href),before);check('FRESH_DATABASE_RESTORES_EXACT_CRITICAL_ROWS');
 const restored=new Client({connectionString:target.href});await restored.connect();try{
  const {rows}=await restored.query("select count(*)::int as count from content_access_requests where used_at is not null");assert.ok(rows[0].count>0);check('CONSUMED_ONE_TIME_GRANTS_REMAIN_CONSUMED');
  const trigger=await restored.query("select 1 from pg_trigger where tgname='guard_original_media_access_scope_trigger' and not tgisinternal");assert.equal(trigger.rowCount,1);check('ORIGINAL_SCOPE_TRIGGER_RESTORED');
 }finally{await restored.end();}
 const validation=out+'/restored';if(existsSync(validation))throw new Error('RESTORE_VALIDATION_DIRECTORY_EXISTS');mkdirSync(validation);
 const env={...values};for(const key of ['DATABASE_URL','PGDATABASE_URL','COZE_SUPABASE_DB_URL'])env[key]=target.href;
 writeFileSync(validation+'/environment.private.json',JSON.stringify(env));
 writeFileSync(validation+'/fixture.private.json',readFileSync(out+'/fixture.private.json'));
 writeFileSync(validation+'/original-preview-fixture.json',readFileSync(out+'/original-preview-fixture.json'));
 const verify=spawnSync(process.execPath,['scripts/integration/comprehensive/run-with-env.mjs',validation,'tsx','scripts/integration/comprehensive/restore-evidence.ts'],{stdio:'inherit',windowsHide:true,timeout:60000});assert.equal(verify.status,0);check('RESTORED_DATABASE_REPLAYS_EXISTING_ENCRYPTED_OBJECTS');
 writeFileSync(resultPath,JSON.stringify({status:'PASS',scope:'ISOLATED_DATABASE_BACKUP_RESTORE_WITH_EXISTING_TEST_OBJECT_STORE_AND_KEYS',sourceDatabase:sourceName,restoredDatabase:database,backupSha256:createHash('sha256').update(bytes).digest('hex'),backupBytes:bytes.length,criticalTables:tables.length,checks,elapsedMs:Date.now()-started,limitations:['Object store was not lost or restored','Encryption keys were retained','Not a production disaster recovery or long-term retention certification']},null,2));
}catch(error){writeFileSync(resultPath,JSON.stringify({status:'FAIL',checks,error:error.message},null,2));throw error;}
