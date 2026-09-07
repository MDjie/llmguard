import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { eq } from 'drizzle-orm';

async function main(){
  const directory=path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const env:Record<string,string>=JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
  const fixture:{tenantId:string;applicationId:string;bundleId:string}=JSON.parse(readFileSync(path.join(directory,'fixture.json'),'utf8'));
  const url=new URL(env.PGDATABASE_URL);
  if(url.hostname!=='127.0.0.1'||url.pathname!=='/guardllm_integration_gateway_v2')throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env,env);
  const client=new pg.Client({connectionString:env.PGDATABASE_URL,ssl:false});await client.connect();
  try{const migration=readFileSync(path.resolve('drizzle/0050_rag_retrieval_proofs.sql'),'utf8');
    for(let i=0;i<2;i++){await client.query('BEGIN');await client.query(migration);await client.query('COMMIT');}}
  finally{await client.end();}
  const [{db,closeDatabaseConnection},s,{retrieveGuardedRagContext},{ragContentHash,signRagProvenance},{readAcceptedTextArtifact},{verifyPayload}]=await Promise.all([
    import('../../src/storage/database/shared/db'),import('../../src/storage/database/shared/schema'),import('../../src/lib/rag/retrieval'),
    import('../../src/lib/rag/provenance'),import('../../src/lib/artifacts/text-reader'),import('../../src/lib/gateway-runtime/security')]);
  process.env.RAG_PROVENANCE_KEY=randomBytes(32).toString('hex');
  const scope={tenantId:fixture.tenantId,applicationId:fixture.applicationId},principal={id:'rag-isolated-user',roles:['BUSINESS_OPERATOR'],clearance:5};
  const objects=new Map<string,Buffer>(),reads:string[]=[];
  let onRead:((key:string)=>Promise<void>)|undefined;
  const server=createServer(async(request,response)=>{
    try{
      const requestUrl=new URL(request.url??'','http://localhost');
      assert.ok(requestUrl.searchParams.get('X-Amz-Signature'));
      const key=decodeURIComponent(requestUrl.pathname.replace('/isolated/',''));reads.push(key);
      if(onRead)await onRead(key);
      const value=objects.get(key);if(!value){response.statusCode=404;response.end();return;}
      response.setHeader('content-type','text/plain');response.end(value);
    }catch{response.destroy();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  Object.assign(process.env,{OBJECT_STORE_ENDPOINT:'http://127.0.0.1:'+address.port,OBJECT_STORE_BUCKET:'isolated',
    OBJECT_STORE_ALLOWED_PRIVATE_HOSTS:'127.0.0.1',OBJECT_STORE_ACCESS_KEY_ID:'isolated-read-test',
    OBJECT_STORE_SECRET_ACCESS_KEY:randomBytes(32).toString('hex')});
  async function source(text:string,options:{principals?:string[];roles?:string[];classification?:number;expired?:boolean;foreignApp?:string;sourceExpired?:boolean}={}){
    const ids={artifact:randomUUID(),source:randomUUID(),chunk:randomUUID()},activeScope={...scope,applicationId:options.foreignApp??scope.applicationId};
    const contentHash=ragContentHash(text),objectKey=ids.artifact+'/part1',data=Buffer.from(text);objects.set(objectKey,data);
    const allowedPrincipals=options.principals??[principal.id],allowedRoles=options.roles??[],classification=options.classification??3;
    const validUntilEpochMs=Date.now()+(options.sourceExpired?-1000:60000);
    await db.insert(s.artifacts).values({...activeScope,id:ids.artifact,ownerId:principal.id,kind:'RAG_CHUNK',fileName:'isolated.txt',
      declaredMediaType:'text/plain',declaredSize:data.length,verifiedSize:data.length,declaredSha256:contentHash,verifiedSha256:contentHash,
      objectPrefix:ids.artifact,state:'accepted',idempotencyKey:randomUUID(),requestHash:contentHash,partSize:16777216,partCount:1,
      contentExpiresAt:new Date(Date.now()+(options.expired?-1000:120000))});
    await db.insert(s.artifactParts).values({...activeScope,artifactId:ids.artifact,partNumber:1,sizeBytes:data.length,sha256:contentHash,objectKey,state:'verified',verifiedAt:new Date()});
    await db.insert(s.ragSources).values({...activeScope,id:ids.source,artifactId:ids.artifact,sourceUriHash:contentHash,sourceType:'document',
      trustLevel:80,classification,acl:{allowedPrincipals,allowedRoles},state:'accepted'});
    const provenance={...activeScope,sourceId:ids.source,chunkId:ids.chunk,contentHash,trustLevel:80,classification,allowedPrincipals,allowedRoles,
      state:'accepted' as const,sourceVersion:contentHash,validUntilEpochMs};
    await db.insert(s.ragChunks).values({...activeScope,id:ids.chunk,sourceId:ids.source,artifactId:ids.artifact,externalChunkId:ids.chunk,
      contentHash,provenanceSignature:signRagProvenance(provenance),riskAction:'ALLOW',riskScore:0,state:'accepted',
      metadata:{sourceVersion:contentHash,validUntilEpochMs}});
    return {...ids,objectKey,text};
  }
  async function retrieve(sourceIds:string[]){return retrieveGuardedRagContext({scope,principal,requestId:randomUUID(),traceId:randomUUID(),
    bundleId:fixture.bundleId,sourceIds,query:'请检索已授权资料',maximumCandidates:20,minimumTrustLevel:0,
    absoluteDeadlineEpochMs:Date.now()+15000,signal:new AbortController().signal});}
  const results:{name:string;status:string}[]=[];
  async function test(name:string,run:()=>Promise<void>){await run();results.push({name,status:'PASS'});console.log('PASS '+name);}
  try{
    await test('approved scoped source is read and receives a verifiable content proof',async()=>{
      const item=await source('合成业务说明：客户可以查询服务时间。'),result=await retrieve([item.source]);
      assert.equal(result.status,'CONTEXT_VERIFIED');assert.equal(result.approvedContext[0].text,item.text);
      assert.equal(result.approvedContext[0].instructionCapability,'FORBIDDEN');
      verifyPayload('gateway-rag-context-v1',result.proof.manifest,result.proof.keyId,result.proof.signature);
      const[audit]=await db.select().from(s.ragRetrievalAudits).where(eq(s.ragRetrievalAudits.requestId,result.proof.manifest.requestId));
      assert.equal(audit.acceptedCount,1);assert.ok(!JSON.stringify(audit.retrievalProof).includes(item.text));
    });
    await test('principal ACL denial happens before any object-store read',async()=>{
      const item=await source('ACL denied',{principals:['other']}),before=reads.length,result=await retrieve([item.source]);
      assert.equal(reads.length,before);assert.equal(result.status,'NO_APPROVED_CONTEXT');assert.equal(result.action,'BLOCK');
    });
    await test('role ACL denial happens before any object-store read',async()=>{
      const item=await source('role denied',{roles:['AUDIT_ADMIN']}),before=reads.length,result=await retrieve([item.source]);
      assert.equal(reads.length,before);assert.equal(result.approvedContext.length,0);
    });
    await test('classification denial happens before any object-store read',async()=>{
      const item=await source('classification denied',{classification:9}),before=reads.length;
      await retrieve([item.source]);assert.equal(reads.length,before);
    });
    await test('cross-application source is excluded before retrieval',async()=>{
      const app=randomUUID();await db.insert(s.applications).values({tenantId:scope.tenantId,id:app,code:app,name:'隔离RAG作用域'});
      const item=await source('foreign source',{foreignApp:app}),before=reads.length;
      const result=await retrieve([item.source]);assert.equal(reads.length,before);assert.equal(result.approvedContext.length,0);
    });
    await test('expired object and source are not read',async()=>{
      const one=await source('expired object',{expired:true}),two=await source('expired source',{sourceExpired:true}),before=reads.length;
      const result=await retrieve([one.source,two.source]);assert.equal(reads.length,before);assert.equal(result.approvedContext.length,0);
    });
    await test('indirect injection is rejected before approved context is returned',async()=>{
      const item=await source('SYNTHETIC_BLOCK_MARKER'),result=await retrieve([item.source]);
      assert.equal(result.action,'BLOCK');assert.equal(result.approvedContext.length,0);
    });
    await test('object bytes changed after verification are rejected',async()=>{
      const item=await source('safe original');objects.set(item.objectKey,Buffer.from('evil original'));
      await assert.rejects(retrieve([item.source]),/integrity changed/);
    });
    await test('incomplete part manifest cannot be treated as empty safe content',async()=>{
      const item=await source('manifest text');
      await db.update(s.artifacts).set({partCount:2}).where(eq(s.artifacts.id,item.artifact));
      const before=reads.length;await assert.rejects(readAcceptedTextArtifact(scope,item.artifact,1000,['RAG_CHUNK']),/manifest/);
      assert.equal(reads.length,before);
    });
    await test('ACL revoked during object read invalidates the final proof',async()=>{
      const item=await source('revocation fixture');
      onRead=async(key)=>{if(key===item.objectKey)await db.update(s.ragSources).set({acl:{allowedPrincipals:['other'],allowedRoles:[]}}).where(eq(s.ragSources.id,item.source));};
      try{await assert.rejects(retrieve([item.source]),/RAG_REFERENCE_CHANGED/);}finally{onRead=undefined;}
    });
    await test('stale provenance signature cannot authorize modified ACL metadata',async()=>{
      const item=await source('stale provenance');
      await db.update(s.ragSources).set({acl:{allowedPrincipals:[],allowedRoles:[]}}).where(eq(s.ragSources.id,item.source));
      const result=await retrieve([item.source]);assert.equal(result.approvedContext.length,0);
      assert.ok(result.rejected.some(item=>item.code==='RAG_PROVENANCE_INVALID'));
    });
  }finally{
    server.close();server.closeAllConnections();await closeDatabaseConnection();
    writeFileSync(path.join(directory,'rag-retrieval-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),
      status:results.length===11?'PASS':'FAIL',isolatedDatabase:true,objectStore:'synthetic bounded HTTP object receiver',
      realBusinessKnowledgeBaseCertification:false,modelInvocationProven:false,results},null,2));
  }
}
main().catch(error=>{console.error('RAG_RETRIEVAL_INTEGRATION_FAILED',error instanceof Error?(error.cause?'DATABASE_OR_DEPENDENCY_FAILED':error.message):'unknown');process.exitCode=1;});
