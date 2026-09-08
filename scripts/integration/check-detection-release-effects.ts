import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import type { GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '../../src/lib/guard-engine-v2';
import { parseCompiledPolicyBundlePayload } from '../../src/lib/policy-bundle/runtime';
import { gateSseStream,StreamBlockedError } from '../../src/lib/stream-gate';
import { evaluateActionIntent } from '../../src/lib/tools/action-firewall';

async function main(){
  const evidenceDir=path.resolve(process.env.REPAIR_EVIDENCE_DIR ?? '.artifact-build/detection-repair-20260908');
  const payload=parseCompiledPolicyBundlePayload(JSON.parse(await readFile(path.join(evidenceDir,'candidate-final/candidate-payload.json'),'utf8')));
  const key=randomBytes(32).toString('hex');
  const bundle={id:'repair-http-component',generation:1,payload};
  const engine=createEngineForPolicyBundle(bundle,key,[],{dlpTokenizationHmacKey:key,outputSecurityEventSink:async()=>{}});
  let sequence=0,toolCalls=0;
  function request(text:string):GuardRequest {
    return {contractVersion:'1.0',context:{tenantId:'synthetic-tenant',applicationId:'synthetic-app',
      traceId:'repair-http-trace',requestId:'repair-http-'+(++sequence),direction:'OUTPUT_COMPLETE',
      sourceType:'AGENT',stage:'OUTPUT_POST',policyBundleId:bundle.id,absoluteDeadlineEpochMs:Date.now()+30000},
      content:{text}};
  }
  const seen:{path:string;action:string;bytes:number}[]=[];
  const server=createServer(async(req,res)=>{
    try{
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);size+=part.length;if(size>16384)throw new Error('BODY_TOO_LARGE');chunks.push(part);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {text?:unknown;fragments?:unknown};
      if(req.url==='/tool'){
        const decision=evaluateActionIntent({intent:{intentId:'synthetic-tool',userGoal:'Routine request with no attack keywords',
          toolName:'fixture.write',parametersDigest:'a'.repeat(64),targetResource:'fixture:item',sideEffect:'WRITE',
          requiredPermissions:['fixture:write'],supportingEnvelopeIds:['fixture-source'],dataDestinations:[],riskBudget:0.1},
          now:Date.now(),parametersDigest:'a'.repeat(64),principalPermissions:[],
          tool:{name:'fixture.write',sideEffect:'WRITE',requiredPermissions:['fixture:write'],allowedDataDestinations:[],highRisk:true,approvalRequired:true},
          action:'write',resource:'fixture:item',contextTainted:false});
        if(decision.disposition==='ALLOW')toolCalls++;
        res.statusCode=decision.disposition==='ALLOW'?200:403;res.end(JSON.stringify({disposition:decision.disposition,reasons:decision.reasonCodes}));return;
      }
      if(req.url==='/stream'){
        if(!Array.isArray(body.fragments)||!body.fragments.every(item=>typeof item==='string'))throw new Error('INVALID_FRAGMENTS');
        const fragments=body.fragments as string[];
        async function* source(){for(const content of fragments)yield 'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n';yield 'data: [DONE]\n\n';}
        res.setHeader('content-type','text/event-stream');
        try{
          for await(const piece of gateSseStream(source(),{mode:'complete',holdbackChars:256,rollingWindowChars:16000,
            maxBufferedBytes:65536,inspectionTimeoutMs:5000,requireUpstreamCompletion:true,
            inspector:async text=>{const d=await engine.evaluate(request(text));return {action:d.action,decisionId:d.decisionId,semanticCoverage:d.degraded?'INCOMPLETE':'COMPLETE'};}}))res.write(piece);
          res.end();
        }catch(error){
          if(!(error instanceof StreamBlockedError))throw error;
          if(!res.headersSent)res.statusCode=403;
          res.end('event: guard.blocked\ndata: {}\n\n');
        }
        return;
      }
      if(typeof body.text!=='string')throw new Error('TEXT_REQUIRED');
      const decision=await engine.evaluate(request(body.text));
      const released=['ALLOW','WARN'].includes(decision.action)?body.text:decision.transformedText??'[blocked]';
      seen.push({path:req.url??'',action:decision.action,bytes:Buffer.byteLength(released)});
      res.statusCode=decision.action==='BLOCK'?403:200;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({action:decision.action,text:released,recheck:decision.transform?.recheckDecisionId??null}));
    }catch{
      if(!res.headersSent)res.statusCode=500;
      res.end('COMPONENT_CHECK_FAILED');
    }
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const url='http://127.0.0.1:'+address.port;
  const post=async(route:string,body:unknown)=>{
    const response=await fetch(url+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    return {status:response.status,text:await response.text()};
  };
  const checks:string[]=[];
  try{
    const plain=await post('/complete',{text:'请查阅正式合同中的保障范围。'});assert.equal(plain.status,200);assert.ok(plain.text.includes('保障范围'));checks.push('http_plain_output_delivered');
    const masked=await post('/complete',{text:'手机: 13812345678\n健康告知: 高血压复诊'});assert.equal(masked.status,200);
    const result=JSON.parse(masked.text) as {action:string;text:string;recheck:string|null};
    assert.equal(result.action,'MASK');assert.ok(result.recheck);assert.ok(result.text.includes('138****5678'));assert.ok(!masked.text.includes('高血压复诊'));assert.ok(!masked.text.includes('13812345678'));
    checks.push('http_client_receives_masked_rechecked_output');
    const secret='api_key=abcdefghijklmnopqrstuvwxyz123456';
    const blocked=await post('/complete',{text:secret});assert.equal(blocked.status,403);assert.ok(!blocked.text.includes(secret));checks.push('http_client_receives_no_blocked_secret');
    const stream=await post('/stream',{fragments:['api_','key=abcdefghijklmnop','qrstuvwxyz123456']});
    assert.equal(stream.status,403);assert.ok(!stream.text.includes('abcdefghijklmnop'));checks.push('split_sse_secret_never_committed_to_http_client');
    const safeStream=await post('/stream',{fragments:['正常','说明']});assert.equal(safeStream.status,200);assert.ok(safeStream.text.includes('[DONE]'));checks.push('safe_sse_completes_over_http');
    const tool=await post('/tool',{});assert.equal(tool.status,403);assert.ok(tool.text.includes('ACTION_PERMISSION_DENIED'));assert.equal(toolCalls,0);
    checks.push('keyword_free_unauthorized_tool_has_zero_side_effects');
    await mkdir(evidenceDir,{recursive:true});
    await writeFile(path.join(evidenceDir,'release-effects.json'),JSON.stringify({status:'PASS',checks,toolCalls,seen,
      candidatePayloadHash:createHash('sha256').update(await readFile(path.join(evidenceDir,'candidate-final/candidate-payload.json'))).digest('hex'),
      execution:'ACTUAL_LOOPBACK_HTTP_WITH_PRODUCTION_ENGINE_STREAM_GATE_AND_ACTION_FIREWALL',
      productionAuthenticationTested:false,databasePermitConsumptionTested:false,productionProxyE2ETested:false,
      syntheticOnly:true,judgeInvocations:0,externalNetworkRequired:false},null,2));
    console.log('PASS '+checks.length+' receiver-side component checks; production proxy/authentication qualification remains separate');
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
main().catch((error:unknown)=>{console.error('DETECTION_RELEASE_EFFECTS_FAILED; fixture content suppressed');if(error instanceof Error)console.error(error.stack?.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,3).join('\n'));process.exitCode=1;});
