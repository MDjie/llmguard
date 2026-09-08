import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {Client} from 'pg';
import {request} from '@playwright/test';
import {archiveQuerySchema} from '../../../src/contracts/http/conversation-archive';
import {cursorBinding,encodeConsoleCursor} from '../../../src/lib/gateway-runtime/console-cursor';
import {listConversationArchives} from '../../../src/lib/conversation-archive/query';
import {closeDatabaseConnection} from '../../../src/storage/database/shared/db';
async function main(){
 const out=process.env.COMPREHENSIVE_RUN_DIR!;const f=JSON.parse(readFileSync(out+'/fixture.private.json','utf8')) as {tenantId:string;applicationId:string;bundleId:string;userId:string;baseURL:string;foreign:{tenantId:string;applicationId:string}};
 const scope={tenantId:f.tenantId,applicationId:f.applicationId},snapshot='archive-query-'+randomUUID(),session='archive-query-'+randomUUID(),now=Date.now()-1000,day=86400000,from=now-180*day,expected:string[]=[],ids:string[]=[];
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{await c.query('BEGIN');await c.query(`insert into gateway_runtime_snapshots(tenant_id,application_id,id,generation,bundle_id,manifest,digest,signature,key_id,state,valid_until) values($1,$2,$3,(select coalesce(max(generation),0)+1 from gateway_runtime_snapshots where tenant_id=$1::varchar and application_id=$2::varchar),$4,'{"syntheticQueryFixture":true}',repeat('0',64),'SYNTHETIC_INVALID_NOT_A_SIGNATURE','SYNTHETIC_QUERY_ONLY','REVOKED',$5)`,[f.tenantId,f.applicationId,snapshot,f.bundleId,new Date(now-1000)]);
 for(const [index,offset] of [-1,0,1,day,day,179*day,180*day].entries()){
  const id='archive-query-'+randomUUID(),accepted=new Date(from+offset);ids.push(id);if(offset>=0)expected.push(id);
  await c.query(`insert into gateway_requests(id,tenant_id,application_id,idempotency_key,request_hmac,snapshot_id,subject_id,auth_context,expires_at,state,session_finalized) values($1,$2,$3,$1,repeat('0',64),$4,$5,'{"syntheticQueryFixture":true}',$6,'TERMINATED',true)`,[id,f.tenantId,f.applicationId,snapshot,f.userId,new Date(now+day)]);
  await c.query(`insert into conversation_archives(request_id,tenant_id,application_id,conversation_id,subject_id,policy,state,integrity,accepted_at,expires_at,hold_until,model_output_unavailable_reason) values($1,$2,$3,$4,$5,'{"mode":"STRICT_OBJECT","retentionDays":180,"version":"archive-policy-1"}','GAPPED','{"syntheticQueryFixture":true,"objectContentVerified":false}',$6,$7,$8,'SYNTHETIC_QUERY_FIXTURE_ONLY')`,[id,f.tenantId,f.applicationId,session,f.userId,accepted,new Date(accepted.getTime()+180*day),new Date(now+day)]);void index;
 }await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}
 const query=archiveQuerySchema.parse({days:180,limit:2,sessionId:session});const binding=cursorBinding(scope,{api:'archive-requests',days:180,sessionId:session});const cursor=encodeConsoleCursor({kind:'LIST',binding,watermark:new Date(now).toISOString(),from:new Date(from).toISOString(),to:new Date(now).toISOString()});
 const api=await request.newContext({baseURL:f.baseURL,storageState:out+'/browser-state.private.json'});
 try{let next:string|null=cursor;const found:string[]=[];let pages=0;while(next){const parameters=new URLSearchParams({days:'180',limit:'2',sessionId:session,cursor:next});const response=await api.get('/api/conversations?'+parameters);assert.equal(response.status(),200);const page=await response.json() as Awaited<ReturnType<typeof listConversationArchives>>;found.push(...page.items.map(item=>item.requestId));next=page.nextCursor;if(++pages>10)throw new Error('PAGINATION_LOOP');}
 assert.equal(new Set(found).size,found.length);assert.deepEqual([...found].sort(),expected.sort());assert(!found.includes(ids[0]));
 await assert.rejects(()=>listConversationArchives(f.foreign,{...query,cursor}),e=>e instanceof Error&&'code' in e&&e.code==='TRACE_CURSOR_INVALID');
 const changed=await api.get('/api/conversations?'+new URLSearchParams({days:'179',limit:'2',sessionId:session,cursor}));assert.equal(changed.status(),400);
 writeFileSync(out+'/'+(process.env.ARCHIVE_BOUNDARY_OUTPUT??'archive-boundaries')+'.json',JSON.stringify({status:'PASS',scope:'REAL_HTTP_PG_SYNTHETIC_METADATA_ONLY',exact180DayBoundary:true,oneMillisecondBeforeExcluded:true,equalTimestampPagination:true,pages,expected:expected.length,received:found.length,duplicateCount:found.length-new Set(found).size,crossScopeCursorRejected:true,changedFilterRejected:true,productionArchiveIntegrity:'NOT_TESTED',runtimeSnapshot:'REVOKED_INVALID_SYNTHETIC_NEVER_ACTIVATED'},null,2));
 }finally{await api.dispose();}
}
main().finally(closeDatabaseConnection).catch((e:unknown)=>{console.error(e instanceof Error?e.message.slice(0,200):'ARCHIVE_BOUNDARY_FAILED');process.exitCode=1;});
