import { loadEnvConfig } from '@next/env';
import { Client } from 'pg';
async function main(){
  loadEnvConfig(process.cwd());
  const raw=process.env.PGDATABASE_URL??process.env.DATABASE_URL;if(!raw)throw new Error('CONFIG_MISSING');
  const url=new URL(raw);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('LOCAL_ONLY');
  const client=new Client({connectionString:raw,ssl:false});await client.connect();
  try{
    const rows=(await client.query<{datname:string}>("select datname from pg_database where datname like 'guardllm_integration%'")).rows;
    const databases=[];
    for(const row of rows){
      const isolated=new URL(url);isolated.pathname='/'+row.datname;
      const check=new Client({connectionString:isolated.href,ssl:false});await check.connect();
      try{databases.push({name:row.datname,...(await check.query("select to_regclass('dictionary_release_sets')::text as release_sets,to_regclass('guard_session_request_receipts')::text as session_receipts")).rows[0]});}
      finally{await check.end();}
    }
    console.log(JSON.stringify({host:url.hostname,businessDatabase:url.pathname.slice(1),isolatedDatabases:databases}));
  }
  finally{await client.end();}
}
main().catch(()=>{console.error('ISOLATED_DB_INSPECTION_FAILED');process.exitCode=1;});
