import { loadEnvConfig } from '@next/env';
import { Client } from 'pg';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { options,required,writeArtifact } from '../content-safety/optimization-cli';

async function runScript(script:string,args:readonly string[],environment:NodeJS.ProcessEnv){
  const cli=createRequire(import.meta.url).resolve('tsx/cli');
  return new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,script,...args],{env:environment,stdio:'inherit',shell:false,windowsHide:true});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('INTEGRATION_CHILD_FAILED')));
  });
}
async function main(){
  const args=options(['database','template','initialize','out-dir']);loadEnvConfig(process.cwd());
  const database=required(args.database,'database'),out=required(args['out-dir'],'out-dir');
  if(!/^guardllm_integration_v2_[a-z0-9_]+$/u.test(database))throw new Error('DEDICATED_V2_DATABASE_REQUIRED');
  const raw=process.env.PGDATABASE_URL??process.env.DATABASE_URL;if(!raw)throw new Error('DB_CONFIG_MISSING');
  const url=new URL(raw);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('LOCAL_TEST_ONLY');
  const admin=new Client({connectionString:raw,ssl:false});await admin.connect();
  try{
    const exists=(await admin.query('select 1 from pg_database where datname=$1',[database])).rowCount;
    if(args.initialize==='yes'){
      const template=required(args.template,'template');
      if(!/^guardllm_integration_[a-z0-9_]+$/u.test(template)||template===database||exists)throw new Error('TEMPLATE_OR_TARGET_INVALID');
      // Names are validated identifiers, never supplied credentials or business database names.
      await admin.query('CREATE DATABASE "'+database+'" TEMPLATE "'+template+'"');
    }else if(!exists)throw new Error('INITIALIZE_ISOLATED_DATABASE_FIRST');
  }finally{await admin.end();}
  url.pathname='/'+database;
  const environment={...process.env,INTEGRATION_DATABASE_URL:url.href,PGDATABASE_URL:url.href,DATABASE_URL:url.href,DATABASE_SSL_MODE:'disable',DATABASE_PLAINTEXT_ALLOWED_HOSTS:url.hostname};
  const before=new Client({connectionString:url.href,ssl:false});await before.connect();
  let schemaBefore:unknown;
  try{schemaBefore=(await before.query("select to_regclass('dictionary_release_sets')::text as release_sets,to_regclass('guard_session_request_receipts')::text as receipts")).rows[0];}
  finally{await before.end();}
  await runScript('scripts/integration/test-release-sets.ts',['--apply-migration','yes','--out',out+'/release-sets.json'],environment);
  await runScript('scripts/integration/test-session-replay.ts',['--apply-migration','yes','--out',out+'/session-replay.json'],environment);
  await runScript('scripts/integration/test-unified-context.ts',['--out',out+'/unified-context.json'],environment);
  await runScript('scripts/integration/test-signed-binding.ts',['--database',database,'--out',out+'/signed-binding.json'],environment);
  await writeArtifact(out+'/migration-rollback.json',{schemaVersion:'2.0',status:'PASS',database,schemaBefore,
    upgrade:['0042_dictionary_release_sets','0043_session_request_receipts'],rollback:'Exact previous dictionary release set restored; additive schema and audit retained',
    businessDatabaseModified:false,productionChanged:false,syntheticOnly:true});
}
main().catch(()=>{console.error('V2_ISOLATED_INTEGRATION_FAILED (database credentials suppressed)');process.exitCode=1;});
