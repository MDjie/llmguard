import {z} from 'zod';
import {request} from '@playwright/test';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {formatForFile,mediaCategory} from '../../../src/lib/media/formats/registry';
async function main(){
const out=process.argv[2];if(!out)throw new Error('Usage: <script> <isolated-fixture-directory>');
const fixture=JSON.parse(readFileSync(out+'/fixture.private.json','utf8')) as {baseURL:string;username:string;password:string;scope:string};
if(fixture.scope!=='ISOLATED_CLONE_ENGINEERING_ONLY')throw new Error('ISOLATED_FIXTURE_REQUIRED');
const api=await request.newContext({baseURL:fixture.baseURL});
const login=await api.post('/api/auth/login',{data:{username:fixture.username,password:fixture.password}});if(login.status()!==200)throw new Error('LOGIN_FAILED_'+login.status());
const csrf=(await api.storageState()).cookies.find(cookie=>cookie.name==='csrf-token')?.value;if(!csrf)throw new Error('CSRF_MISSING');const headers={'x-csrf-token':csrf,origin:fixture.baseURL};
const results:Array<Record<string,unknown>>=[];
async function upload(name:string,bytes:Buffer,mime:string,kind:string,expected:string,metadata:Record<string,unknown>={},declaredHash?:string){
 const digest=createHash('sha256').update(bytes).digest('hex');
 let create=await api.post('/api/v1/guard/artifacts/uploads',{headers,data:{kind,fileName:name,mediaType:mime,sizeBytes:bytes.length,sha256:declaredHash??digest,idempotencyKey:randomUUID(),metadata}});
 if(create.status()===429){await new Promise(resolve=>setTimeout(resolve,Math.max(1000,Number(create.headers()['retry-after']??60)*1000)));create=await api.post('/api/v1/guard/artifacts/uploads',{headers,data:{kind,fileName:name,mediaType:mime,sizeBytes:bytes.length,sha256:declaredHash??digest,idempotencyKey:randomUUID(),metadata}});}
 if(create.status()!==201)throw new Error('CREATE_'+name+'_'+create.status());const artifact=z.object({data:z.object({id:z.uuid()})}).parse(await create.json()).data;
 const part=await api.put('/api/v1/guard/artifacts/'+artifact.id+'/parts/1/content',{headers:{...headers,'content-type':'application/octet-stream'},data:bytes});if(part.status()!==200)throw new Error('PART_'+name+'_'+part.status());
 const complete=await api.post('/api/v1/guard/artifacts/'+artifact.id+'/complete',{headers,data:{parts:[{partNumber:1,sizeBytes:bytes.length,sha256:digest}]}});if(complete.status()!==202)throw new Error('COMPLETE_'+name+'_'+complete.status());
 for(let attempt=0;attempt<30;attempt++){const response=await api.get('/api/v1/guard/artifacts/'+artifact.id);if(response.status()!==200)throw new Error('GET_'+name+'_'+response.status());const value=z.object({data:z.object({state:z.string(),failureCode:z.string().nullable(),detectedMediaType:z.string().nullable()})}).parse(await response.json()).data;if(['accepted','failed','quarantined'].includes(value.state)){results.push({name,state:value.state,expected,code:value.failureCode,detectedType:value.detectedMediaType,pass:value.state===expected});return;}await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('VERIFICATION_TIMEOUT_'+name);
}
try{
 for(const name of readdirSync(out+'/format-fixtures')){const fmt=formatForFile(name,name.endsWith('.ts')?'video/mp2t':'');if(!fmt)continue;const mime=fmt.mimeTypes[0];await upload(name,readFileSync(out+'/format-fixtures/'+name),mime,mediaCategory(fmt,mime).toUpperCase(),'accepted',name.endsWith('.pcm')?{pcm:{sampleRate:16000,channels:2,sampleFormat:'s16le'}}:name.startsWith('legacy-')?{encoding:'gb18030'}:{});}
 await upload('forged.png',Buffer.from('ordinary text'),'image/png','IMAGE','quarantined');
 await upload('bad-tail.txt',Buffer.concat([Buffer.from('A'.repeat(600)),Buffer.from([0xc3])]),'text/plain','TEXT','quarantined');
 await upload('wrong-hash.txt',Buffer.from('ordinary text'),'text/plain','TEXT','quarantined',{},'0'.repeat(64));
 writeFileSync(out+'/upload-matrix.json',JSON.stringify({scope:'REAL_AUTHENTICATED_API_STORAGE_VERIFIER',results},null,2));console.log(JSON.stringify(results));if(results.some(item=>!item.pass))process.exitCode=1;
}finally{await api.dispose();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'UPLOAD_MATRIX_FAILED');process.exitCode=1;});
