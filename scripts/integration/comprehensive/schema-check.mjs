import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const directory=process.argv[2];
const values=JSON.parse(readFileSync(directory+'/environment.private.json','utf8'));
const url=new URL(values.DATABASE_URL);
if(url.hostname!=='127.0.0.1'||url.port!=='5438')throw new Error('ISOLATION_REQUIRED');
if (!/^\/guardllm_integration_full_[0-9]+$/.test(url.pathname)) throw new Error('ISOLATION_REQUIRED');
const {Client}=await import('pg'); const client=new Client({connectionString:url.href}); await client.connect();
try { const {rows}=await client.query("select count(*)::int count from information_schema.tables where table_schema='public'"); if(rows[0].count!==0) throw new Error('EMPTY_DATABASE_REQUIRED'); } finally { await client.end(); }
const child=spawn(process.execPath,['scripts/integration/run-database-tests.mjs','--apply-schema'],{stdio:'inherit',windowsHide:true,env:{...process.env,INTEGRATION_DATABASE_URL:url.href}});
child.on('exit',code=>{process.exitCode=code??1});
