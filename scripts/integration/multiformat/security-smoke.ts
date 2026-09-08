import {request,type APIRequestContext} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
const credential=z.object({username:z.string(),password:z.string()}).passthrough();
const fixtureSchema=credential.extend({baseURL:z.url(),scope:z.literal('ISOLATED_CLONE_ENGINEERING_ONLY'),other:credential,foreign:credential});
const artifactSchema=z.object({data:z.object({id:z.uuid(),state:z.string(),partSize:z.number().int().positive(),partCount:z.number().int().positive()}).passthrough()});
async function main(){
 const out=process.argv[2];if(!out)throw new Error('Usage: security-smoke.ts <isolated-fixture-directory>');
 const fixture=fixtureSchema.parse(JSON.parse(readFileSync(out+'/fixture.private.json','utf8')));
 const sessions:APIRequestContext[]=[],results:Array<{test:string;pass:boolean;status?:number;state?:string}>=[];
 const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
 async function session(credentials:z.infer<typeof credential>){const api=await request.newContext({baseURL:fixture.baseURL});sessions.push(api);const login=await api.post('/api/auth/login',{data:{username:credentials.username,password:credentials.password}});if(login.status()!==200)throw new Error('LOGIN_FAILED_'+login.status());const csrf=(await api.storageState()).cookies.find(item=>item.name==='csrf-token')?.value;if(!csrf)throw new Error('CSRF_MISSING');return {api,headers:{'x-csrf-token':csrf,origin:fixture.baseURL}};}
 try{
 const owner=await session(fixture),other=await session(fixture.other),foreign=await session(fixture.foreign);
 const bytes=Buffer.from('immutable content');
 const created=await owner.api.post('/api/v1/guard/artifacts/uploads',{headers:owner.headers,data:{kind:'TEXT',fileName:'immutable.txt',mediaType:'text/plain',sizeBytes:bytes.length,sha256:hash(bytes),idempotencyKey:randomUUID()}});
 if(created.status()!==201)throw new Error('CREATE_FAILED_'+created.status());const artifact=artifactSchema.parse(await created.json()).data;
 for(const [name,current] of [['other-principal',other],['foreign-tenant',foreign]] as const){
  const read=await current.api.get('/api/v1/guard/artifacts/'+artifact.id);results.push({test:name+'-read',status:read.status(),pass:read.status()===404});
  const put=await current.api.put('/api/v1/guard/artifacts/'+artifact.id+'/parts/1/content',{headers:{...current.headers,'content-type':'application/octet-stream'},data:bytes});results.push({test:name+'-write',status:put.status(),pass:put.status()===409});
 }
 const put=async(data:Buffer)=>owner.api.put('/api/v1/guard/artifacts/'+artifact.id+'/parts/1/content',{headers:{...owner.headers,'content-type':'application/octet-stream'},data});
 if((await put(bytes)).status()!==200)throw new Error('FIRST_PUT_FAILED');if((await put(Buffer.alloc(bytes.length,66))).status()!==200)throw new Error('IMMUTABLE_RETRY_FAILED');
 const complete=await owner.api.post('/api/v1/guard/artifacts/'+artifact.id+'/complete',{headers:owner.headers,data:{parts:[{partNumber:1,sizeBytes:bytes.length,sha256:hash(bytes)}]}});if(complete.status()!==202)throw new Error('COMPLETE_FAILED');
 async function terminal(id:string){for(let i=0;i<30;i++){const r=await owner.api.get('/api/v1/guard/artifacts/'+id);if(r.status()!==200)throw new Error('STATE_READ_FAILED');const state=artifactSchema.parse(await r.json()).data.state;if(['accepted','quarantined','failed'].includes(state))return state;await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('VERIFICATION_TIMEOUT');}
 const state=await terminal(artifact.id);results.push({test:'immutable-part-retains-original-bytes',state,pass:state==='accepted'});
 const multipart=Buffer.alloc(17*1024*1024,65);
 const response=await owner.api.post('/api/v1/guard/artifacts/uploads',{headers:owner.headers,data:{kind:'TEXT',fileName:'multipart.txt',mediaType:'text/plain',sizeBytes:multipart.length,sha256:hash(multipart),idempotencyKey:randomUUID()}});if(response.status()!==201)throw new Error('MULTIPART_CREATE_FAILED');const multi=artifactSchema.parse(await response.json()).data,parts:Array<{partNumber:number;sizeBytes:number;sha256:string}>=[];
 for(let n=1;n<=multi.partCount;n++){const part=multipart.subarray((n-1)*multi.partSize,n*multi.partSize);const response=await owner.api.put('/api/v1/guard/artifacts/'+multi.id+'/parts/'+n+'/content',{headers:{...owner.headers,'content-type':'application/octet-stream'},data:part});if(response.status()!==200)throw new Error('MULTIPART_PUT_FAILED_'+response.status());parts.push({partNumber:n,sizeBytes:part.length,sha256:hash(part)});}
 const done=await owner.api.post('/api/v1/guard/artifacts/'+multi.id+'/complete',{headers:owner.headers,data:{parts}});if(done.status()!==202)throw new Error('MULTIPART_COMPLETE_FAILED');const multiState=await terminal(multi.id);results.push({test:'17MiB-two-part-integrity',state:multiState,pass:multiState==='accepted'});
 writeFileSync(out+'/security-smoke.json',JSON.stringify({scope:'REAL_ISOLATED_OWNER_TENANT_IMMUTABILITY_MULTIPART',results},null,2));console.log(JSON.stringify(results));if(results.some(result=>!result.pass))process.exitCode=1;
 }finally{await Promise.all(sessions.map(api=>api.dispose()));}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'SECURITY_SMOKE_FAILED');process.exitCode=1;});
