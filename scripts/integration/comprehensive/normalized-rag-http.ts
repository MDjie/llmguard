import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {and,eq} from 'drizzle-orm';
import {request} from '@playwright/test';
import {db,closeDatabaseConnection} from '@/storage/database/shared/db';
import {guardJobs} from '@/storage/database/shared/schema';
import {scopePredicate} from '@/lib/tenancy';
import {authenticatedApi} from './auth.mjs';
const out=resolve(process.env.COMPREHENSIVE_RUN_DIR!),results:Array<{id:string;status:string;http:number}>=[];
async function main(){
 const owner=await authenticatedApi(out),other=await authenticatedApi(out,'other'),foreign=await authenticatedApi(out,'foreign'),anonymous=await request.newContext({baseURL:'http://127.0.0.1:58089'});
 try{
  const jobs=await db.select().from(guardJobs).where(and(scopePredicate(guardJobs,owner.fixture),eq(guardJobs.ownerId,owner.fixture.userId),eq(guardJobs.jobType,'intake'),eq(guardJobs.status,'completed')));
  const intake=jobs.find(job=>job.result?.operationalOutcome==='COMPLETE'&&job.result?.degraded===false&&Array.isArray(job.result?.normalizedAssets));assert.ok(intake);
  const payload={intakeJobId:intake.id,sourceUri:'urn:synthetic:rag-http',idempotencyKey:randomUUID()};
  const path='/api/v1/guard/rag/ingest-media';
  for(const [id,session,expected] of [['OWNER',owner,202],['OTHER_OWNER',other,422],['FOREIGN_TENANT',foreign,422]] as const){
   const response=await session.api.post(path,{headers:session.headers,data:payload});assert.equal(response.status(),expected,id);results.push({id,status:'PASS',http:response.status()});
   if(id==='OWNER'){const body=await response.json();assert.equal(body.success,true);assert.equal(body.data.nativeCoverageClaimed,false);assert.ok(body.data.jobs.length>0);}
  }
  const anon=await anonymous.post(path,{data:payload});assert.equal(anon.status(),401);results.push({id:'ANONYMOUS',status:'PASS',http:anon.status()});
  const invalid=await owner.api.post(path,{headers:owner.headers,data:{...payload,intakeJobId:'invalid'}});assert.equal(invalid.status(),400);results.push({id:'MALFORMED_SOURCE',status:'PASS',http:invalid.status()});
 }finally{await Promise.all([owner.api.dispose(),other.api.dispose(),foreign.api.dispose(),anonymous.dispose()]);}
 writeFileSync(out+'/normalized-rag-http.json',JSON.stringify({status:'PASS',scope:'REAL_HTTP_ISOLATED_DATABASE',results},null,2));console.log(JSON.stringify(results));
}
main().catch(error=>{writeFileSync(out+'/normalized-rag-http.json',JSON.stringify({status:'FAIL',results,error:error instanceof Error?error.message:'FAILED'},null,2));process.exitCode=1;console.error(error instanceof Error?error.message:'FAILED');}).finally(closeDatabaseConnection);
