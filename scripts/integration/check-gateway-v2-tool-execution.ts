import assert from 'node:assert/strict';
import { createServer, request as httpsRequest } from 'node:https';
import { randomUUID, X509Certificate, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import type { ToolExecutionRequest, ToolExecutionQuery, ToolExecutorReceipt } from '../../src/lib/tools/executor';

async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const env:Record<string,string> = JSON.parse(readFileSync(path.join(directory,'environment.json'),'utf8'));
  const fixture:{tenantId:string;applicationId:string;bundleId:string;apiKey:string;credentialId:string} = JSON.parse(readFileSync(path.join(directory,'fixture.json'),'utf8'));
  const url = new URL(env.PGDATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env,env);
  delete process.env.TOOL_PERMIT_KEY_FILE; delete process.env.TOOL_PERMIT_SIGNING_KEY_FILE;
  delete process.env.TOOL_PERMIT_SIGNING_KEY;
  process.env.TOOL_PERMIT_KEY = randomBytes(32).toString('hex');
  const scope = {tenantId:fixture.tenantId,applicationId:fixture.applicationId};
  const sqlClient = new pg.Client({connectionString:env.PGDATABASE_URL,ssl:false});
  await sqlClient.connect();
  try {
    for (const file of ['0049_tool_execution_receipts.sql','0051_tool_execution_reconciliation.sql','0052_tool_authority_compensation.sql']) {
      const migration = readFileSync(path.resolve('drizzle',file),'utf8');
      for(let repeat=0;repeat<2;repeat++){await sqlClient.query('BEGIN');await sqlClient.query(migration);await sqlClient.query('COMMIT');}
    }
  } finally { await sqlClient.end(); }
  const [{db,closeDatabaseConnection},s,service,execution,{canonicalJson},{sha256},{verifyToolExecutionAuthorization,verifyToolQueryAuthorization},reconciliation] = await Promise.all([
    import('../../src/storage/database/shared/db'),import('../../src/storage/database/shared/schema'),
    import('../../src/lib/tools/service'),import('../../src/lib/tools/execution'),
    import('../../src/lib/policy-bundle'),import('../../src/lib/gateway-runtime/protocol'),import('../../src/lib/tools/executor'),import('../../src/lib/tools/reconciliation'),
  ]);
  delete process.env.TOOL_PERMIT_SIGNING_KEY; delete process.env.TOOL_PERMIT_SIGNING_KEY_FILE; delete process.env.TOOL_PERMIT_KEY_FILE;
  const tlsFile=(name:string)=>path.join(directory,'tls',name);
  const calls:ToolExecutionRequest[] = [];
  const receipts=new Map<string,ToolExecutorReceipt>();let queries=0;
  const sideEffects=new Map<string,number>();
  const server = createServer({key:readFileSync(tlsFile('server.key')),cert:readFileSync(tlsFile('server.crt')),
    ca:readFileSync(tlsFile('ca.crt')),requestCert:true,rejectUnauthorized:true},async(request,response)=>{
    try {
      const chunks:Buffer[]=[];for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw=Buffer.concat(chunks).toString('utf8');
      if(request.url==='/status') {
        const body=JSON.parse(raw) as ToolExecutionQuery;
        verifyToolQueryAuthorization(body,String(request.headers['x-guard-request-digest']),String(request.headers['x-guard-execution-key-id']),String(request.headers['x-guard-execution-signature']));
        assert.equal(body.operation,'QUERY');assert.ok(!('parameters' in body));assert.ok(!('action' in body));
        const original=calls.find(value=>value.invocationId===body.invocationId),receipt=receipts.get(body.invocationId);
        assert.ok(original&&receipt);assert.equal(original.subjectId,body.subjectId);assert.equal(receipt.requestDigest,body.originalRequestDigest);queries++;
        response.setHeader('content-type','application/json');response.end(JSON.stringify(original.parameters.mode==='query-forged'?{...receipt,requestDigest:'f'.repeat(64)}:receipt));return;
      }
      assert.equal(request.url,'/execute');
      const body=JSON.parse(raw) as ToolExecutionRequest;
      verifyToolExecutionAuthorization(body,String(request.headers['x-guard-request-digest']),String(request.headers['x-guard-execution-key-id']),String(request.headers['x-guard-execution-signature']));
      calls.push(body);
      // The database must acknowledge permit consumption before this external receiver sees the request.
      const [row]=await db.select().from(s.toolInvocations).where(eq(s.toolInvocations.id,body.invocationId));
      assert.equal(row.status,'executing');assert.ok(row.permitConsumedAt);
      assert.equal(row.executionRequestDigest,sha256(raw));
      const mode=body.parameters.mode;
      if(body.action==='write') {
        assert.ok(row.approvalDecisionId);
        if(body.compensatesInvocationId) {
          const original=receipts.get(body.compensatesInvocationId);assert.ok(original);assert.equal(original.requestDigest,body.originalExecutionDigest);
          assert.equal(sideEffects.get(body.resource),1);sideEffects.set(body.resource,0);
        } else {assert.equal(sideEffects.get(body.resource)??0,0);sideEffects.set(body.resource,1);}
      }
      const result=mode==='blocked'||mode==='disconnect-blocked'?'SYNTHETIC_BLOCK_MARKER':'隔离工具执行成功';
      const receipt:ToolExecutorReceipt={protocolVersion:'1.0',invocationId:body.invocationId,...scope,
        executorId:body.executorId,toolId:body.toolId,toolVersion:body.toolVersion,
        requestDigest:sha256(raw),resultDigest:sha256(result),status:'SUCCEEDED',result,completedAtEpochMs:Date.now()};
      receipts.set(body.invocationId,receipt);
      if(mode==='disconnect'||mode==='disconnect-blocked'||mode==='query-forged'){response.destroy();return;}
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify(mode==='forged'?{...receipt,requestDigest:'f'.repeat(64)}:mode==='unknown-receipt'?{...receipt,status:'UNKNOWN'}:receipt));
    } catch { response.destroy(); }
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const toolId=randomUUID(),toolName='isolated-tool-'+toolId,definitionDigest=sha256(toolName);
  const endpoint='https://127.0.0.1:'+address.port+'/execute';
  const executor={...scope,toolId,toolVersion:'1.0',definitionDigest,executorId:'isolated-agentguard',
    endpoint,statusEndpoint:'https://127.0.0.1:'+address.port+'/status',serverCertificateSha256:new X509Certificate(readFileSync(tlsFile('server.crt'))).fingerprint256.replaceAll(':','').toLowerCase(),
    caFile:tlsFile('ca.crt'),certificateFile:tlsFile('client.crt'),keyFile:tlsFile('client.key'),timeoutMs:10000,maximumResponseBytes:1048576};
  delete process.env.TOOL_EXECUTORS_FILE;
  process.env.TOOL_EXECUTORS_JSON=JSON.stringify([executor]);
  const results:{name:string;status:string}[]=[];
  async function test(name:string,fn:()=>Promise<void>){await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}
  const principalId='application-credential:'+fixture.credentialId;
  async function authorize(mode:string,agentRunId=randomUUID(),budget=100){
    const parameters={mode};
    const authorized=await service.authorizeToolInvocation({scope,principalId,roles:[],permissions:['guard:use'],
      traceId:randomUUID(),requestId:randomUUID(),bundleId:fixture.bundleId,toolId,action:'read',resource:'/isolated/test',
      parameters,agentRunId,maximumToolSteps:32,contextTainted:false,
      actionIntent:{intentId:randomUUID(),userGoal:'隔离测试',toolName,parametersDigest:sha256(canonicalJson(parameters)),
        targetResource:'/isolated/test',sideEffect:'READ',requiredPermissions:['guard:use'],supportingEnvelopeIds:[],
        dataDestinations:[],riskBudget:budget,expiresAtEpochMs:Date.now()+60000}});
    return authorized;
  }
  async function approved(mode:string){
    const value=await authorize(mode);
    assert.equal(value.disposition,'ALLOW');
    assert.ok('permitToken' in value && value.permitToken && 'invocation' in value);
    return {scope,principalId,invocationId:value.invocation.id,permitToken:value.permitToken,parameters:{mode},signal:new AbortController().signal};
  }
  async function status(id:string){const[row]=await db.select().from(s.toolInvocations).where(eq(s.toolInvocations.id,id));return row;}
  async function freshSource() {
    const id=randomUUID();
    await new Promise<void>((resolve,reject)=>{
      const req=httpsRequest('https://127.0.0.1:58087/v1/chat/completions',{method:'POST',ca:readFileSync(tlsFile('ca.crt')),cert:readFileSync(tlsFile('client.crt')),key:readFileSync(tlsFile('client.key')),signal:AbortSignal.timeout(65000),headers:{authorization:'Bearer '+fixture.apiKey,'content-type':'application/json','x-request-id':id,'idempotency-key':id}},response=>{
        response.resume();response.on('end',()=>response.statusCode===200?resolve():reject(new Error('SOURCE_REQUEST_'+response.statusCode)));response.on('error',reject);
      });req.on('error',reject);req.end(JSON.stringify({model:'test',stream:false,messages:[{role:'system',content:'仅处理用户授权操作。'},{role:'user',content:'请为隔离测试记录更新准备审批材料 '+id}]}));
    });
    return 'gw/'+id+'/'+sha256('/messages/1/content').slice(0,32);
  }
  async function writeInput(resource='/isolated/'+randomUUID(),agentRunId=randomUUID(),parentId?:string) {
    const source=await freshSource(), parameters={mode:'normal'};
    return {scope,principalId,roles:[],permissions:['guard:use'],traceId:randomUUID(),requestId:randomUUID(),bundleId:fixture.bundleId,toolId,action:'write',resource,parameters,agentRunId,maximumToolSteps:32,contextTainted:false,
      ...(parentId?{compensatesInvocationId:parentId}:{}),
      actionIntent:{intentId:randomUUID(),userGoal:parentId?'补偿隔离写操作':'隔离写操作',toolName,parametersDigest:sha256(canonicalJson(parameters)),targetResource:resource,sideEffect:'WRITE' as const,requiredPermissions:['guard:use'],supportingEnvelopeIds:[source],dataDestinations:[],riskBudget:100,expiresAtEpochMs:Date.now()+60000}};
  }
  async function issueWrite(input:Awaited<ReturnType<typeof writeInput>>) {
    const pending=await service.authorizeToolInvocation(input);assert.equal(pending.disposition,'REQUIRE_APPROVAL');assert.ok('invocation' in pending);
    await service.decideToolApproval(scope,'isolated-security-approver',pending.invocation.id,'approve','批准本次隔离操作及其固定参数');
    const allowed=await service.authorizeToolInvocation(input);assert.ok('permitToken' in allowed&&allowed.permitToken&&'invocation' in allowed);
    return {scope,principalId,invocationId:allowed.invocation.id,permitToken:allowed.permitToken,parameters:input.parameters,signal:new AbortController().signal};
  }
  try {
    await db.insert(s.toolRegistry).values({...scope,id:toolId,name:toolName,version:'1.0',kind:'HTTP',endpoint,
      serverIdentity:executor.executorId,allowedActions:['read'],resourcePatterns:['/isolated/*'],
      parameterPolicy:{required:['mode'],allowedKeys:['mode']},sideEffect:'READ',requiredPermissions:['guard:use'],
      definitionDigest,sourceUri:'https://fixture.invalid/tool',sourceDigest:'sha256:'+definitionDigest,
      signatureKeyId:'isolated-only',signature:'fixture-only-not-production-admission',licenseSpdx:'MIT',
      noticeDigest:'sha256:'+definitionDigest,scannerDefinitionDigest:'sha256:'+definitionDigest,networkDomains:['127.0.0.1'],
      approvalIds:['isolated-review-1','isolated-review-2'],createdBy:'integration',status:'active'});
    await test('managed execution consumes permit before peer receives request',async()=>{
      const input=await approved('normal'),before=calls.length,result=await execution.executeToolInvocation(input);
      assert.equal(calls.length,before+1);assert.equal(result.action,'ALLOW');assert.ok('result' in result&&result.result==='隔离工具执行成功');
      const row=await status(input.invocationId);assert.equal(row.status,'completed');assert.ok(row.executionReceipt?.evidenceHmac);
      assert.ok(!('result' in row.executionReceipt!));
    });
    await test('concurrent duplicate permits trigger exactly one external execution',async()=>{
      const input=await approved('normal'),before=calls.length;
      const outcomes=await Promise.allSettled([execution.executeToolInvocation(input),execution.executeToolInvocation(input)]);
      assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);assert.equal(calls.length,before+1);
    });
    await test('changed parameters and principal are rejected before external execution',async()=>{
      const input=await approved('normal'),before=calls.length;
      await assert.rejects(execution.executeToolInvocation({...input,parameters:{mode:'forged'}}));
      await assert.rejects(execution.executeToolInvocation({...input,principalId:'other'}));assert.equal(calls.length,before);
      assert.equal((await status(input.invocationId)).status,'authorized');
    });
    await test('legacy result endpoint cannot consume managed execution permits',async()=>{
      const input=await approved('normal'),before=calls.length;
      await assert.rejects(service.guardToolResult({...input,result:'forged-safe'}));
      assert.equal(calls.length,before);assert.equal((await status(input.invocationId)).status,'authorized');
    });
    await test('tool output is inspected using the authorized bundle before release',async()=>{
      const input=await approved('blocked'),result=await execution.executeToolInvocation(input);
      assert.equal(result.action,'BLOCK');assert.ok(!('result' in result));
      assert.equal((await status(input.invocationId)).status,'result_blocked');
    });
    await test('connection loss preserves UNKNOWN and forbids replay',async()=>{
      const input=await approved('disconnect'),before=calls.length;
      await assert.rejects(execution.executeToolInvocation(input));assert.equal((await status(input.invocationId)).status,'execution_unknown');
      await assert.rejects(execution.executeToolInvocation(input));assert.equal(calls.length,before+1);
    });
    await test('forged receipt preserves UNKNOWN without releasing tool output',async()=>{
      const input=await approved('forged');await assert.rejects(execution.executeToolInvocation(input));
      assert.equal((await status(input.invocationId)).status,'execution_unknown');
    });
    await test('changed operator executor configuration invalidates previously issued permit',async()=>{
      const input=await approved('normal'),before=calls.length;
      process.env.TOOL_EXECUTORS_JSON=JSON.stringify([{...executor,timeoutMs:9000}]);
      try {await assert.rejects(execution.executeToolInvocation(input));assert.equal(calls.length,before);}
      finally {process.env.TOOL_EXECUTORS_JSON=JSON.stringify([executor]);}
    });
    await test('disabled tool cannot execute an outstanding permit',async()=>{
      const input=await approved('normal'),before=calls.length;
      await db.update(s.toolRegistry).set({status:'disabled'}).where(eq(s.toolRegistry.id,toolId));
      try {await assert.rejects(execution.executeToolInvocation(input));assert.equal(calls.length,before);}
      finally {await db.update(s.toolRegistry).set({status:'active'}).where(eq(s.toolRegistry.id,toolId));}
    });
    await test('read-only outcome query recovers a lost receipt without replaying execution',async()=>{
      const input=await approved('disconnect');await assert.rejects(execution.executeToolInvocation(input));const before=calls.length,beforeQueries=queries,queryId=randomUUID();
      const result=await reconciliation.reconcileToolInvocation({...input,queryId});assert.equal(result.status,'completed');assert.equal(result.resultReturned,false);assert.equal(calls.length,before);assert.equal(queries,beforeQueries+1);
      assert.ok(!JSON.stringify(result.reconciliations).includes('隔离工具执行成功'));assert.equal(result.reconciliations.length,1);
      await reconciliation.reconcileToolInvocation({...input,queryId});assert.equal(queries,beforeQueries+1);
      await assert.rejects(execution.executeToolInvocation(input));assert.equal(calls.length,before);
    });
    await test('UNKNOWN receipt remains immutable when later query resolves the execution',async()=>{
      const input=await approved('unknown-receipt');await assert.rejects(execution.executeToolInvocation(input));
      const before=JSON.stringify((await status(input.invocationId)).executionReceipt);
      await reconciliation.reconcileToolInvocation({...input,queryId:randomUUID()});const row=await status(input.invocationId);
      assert.equal(row.status,'completed');assert.equal(JSON.stringify(row.executionReceipt),before);assert.equal(row.executionReconciliations.length,1);
      await assert.rejects(db.update(s.toolInvocations).set({executionReceipt:{forged:true}}).where(eq(s.toolInvocations.id,input.invocationId)));
      await assert.rejects(db.update(s.toolInvocations).set({executionReconciliations:[]}).where(eq(s.toolInvocations.id,input.invocationId)));
      await assert.rejects(db.update(s.toolInvocations).set({permitConsumedAt:null}).where(eq(s.toolInvocations.id,input.invocationId)));
    });
    await test('recovered unsafe result is blocked and never returned by reconciliation',async()=>{
      const input=await approved('disconnect-blocked');await assert.rejects(execution.executeToolInvocation(input));const before=calls.length;
      const result=await reconciliation.reconcileToolInvocation({...input,queryId:randomUUID()});assert.equal(result.status,'result_blocked');assert.equal(calls.length,before);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_BLOCK_MARKER'));
    });
    await test('forged status response retains UNKNOWN and appends only failed-query evidence',async()=>{
      const input=await approved('query-forged');await assert.rejects(execution.executeToolInvocation(input));const before=calls.length;
      const result=await reconciliation.reconcileToolInvocation({...input,queryId:randomUUID()});assert.equal(result.status,'execution_unknown');assert.equal(result.reconciliations[0].outcome,'QUERY_FAILED');assert.equal(calls.length,before);
    });
    await test('a different principal cannot query the original execution outcome',async()=>{
      const input=await approved('disconnect');await assert.rejects(execution.executeToolInvocation(input));const before=queries;
      await assert.rejects(reconciliation.reconcileToolInvocation({...input,principalId:'different-principal',queryId:randomUUID()}));assert.equal(queries,before);
    });
    await db.update(s.toolRegistry).set({sideEffect:'WRITE',allowedActions:['read','write']}).where(eq(s.toolRegistry.id,toolId));
    await test('WRITE requires verified user evidence, different approver and exact approved parameters',async()=>{
      const input=await writeInput(),before=calls.length;
      await assert.rejects(service.authorizeToolInvocation({...input,actionIntent:{...input.actionIntent,supportingEnvelopeIds:['forged-user-source']}}));
      const source=input.actionIntent.supportingEnvelopeIds[0];
      await assert.rejects(service.authorizeToolInvocation({...input,actionIntent:{...input.actionIntent,supportingEnvelopeIds:[source.replace(sha256('/messages/1/content').slice(0,32),sha256('/messages/0/content').slice(0,32))]}}));
      await assert.rejects(service.authorizeToolInvocation({...input,principalId:'other'}));
      const pending=await service.authorizeToolInvocation(input);assert.equal(pending.disposition,'REQUIRE_APPROVAL');assert.ok('invocation' in pending);assert.equal(calls.length,before);assert.equal(sideEffects.get(input.resource),undefined);
      await assert.rejects(service.decideToolApproval(scope,principalId,pending.invocation.id,'approve','self'));
      await service.decideToolApproval(scope,'isolated-security-approver',pending.invocation.id,'approve','批准固定测试参数');
      await assert.rejects(service.authorizeToolInvocation({...input,parameters:{mode:'changed'},actionIntent:{...input.actionIntent,parametersDigest:sha256(canonicalJson({mode:'changed'}))}}));
      const allowed=await service.authorizeToolInvocation(input);assert.ok('permitToken' in allowed&&allowed.permitToken&&'invocation' in allowed);
      const execute={scope,principalId,invocationId:allowed.invocation.id,permitToken:allowed.permitToken,parameters:input.parameters,signal:new AbortController().signal};
      const result=await execution.executeToolInvocation(execute);assert.equal(result.action,'ALLOW');assert.equal(sideEffects.get(input.resource),1);
      await assert.rejects(execution.executeToolInvocation(execute));assert.equal(calls.length,before+1);
      await assert.rejects(db.update(s.toolInvocations).set({actionIntent:{changed:true}}).where(eq(s.toolInvocations.id,execute.invocationId)));
      await assert.rejects(db.update(s.toolInvocations).set({supportingEnvelopeIds:[]}).where(eq(s.toolInvocations.id,execute.invocationId)));
    });
    await test('compensation uses a fresh approval and permit with a durable original-effect binding',async()=>{
      const original=await writeInput(),executionInput=await issueWrite(original);await execution.executeToolInvocation(executionInput);assert.equal(sideEffects.get(original.resource),1);
      const compensation=await writeInput(original.resource,original.agentRunId,executionInput.invocationId),undo=await issueWrite(compensation);
      const result=await execution.executeToolInvocation(undo);assert.equal(result.action,'ALLOW');assert.equal(sideEffects.get(original.resource),0);
      assert.equal((await status(undo.invocationId)).compensatesInvocationId,executionInput.invocationId);assert.ok((await status(executionInput.invocationId)).permitConsumedAt);
      await assert.rejects(execution.executeToolInvocation(executionInput));await assert.rejects(execution.executeToolInvocation(undo));
      await assert.rejects(service.authorizeToolInvocation({...compensation,requestId:randomUUID()}));
      await assert.rejects(service.authorizeToolInvocation({...compensation,requestId:randomUUID(),compensatesInvocationId:undo.invocationId}));
    });
    await test('unconfirmed WRITE effect cannot be compensated until read-only reconciliation confirms it',async()=>{
      const original=await writeInput();original.parameters.mode='disconnect';original.actionIntent.parametersDigest=sha256(canonicalJson(original.parameters));
      const issued=await issueWrite(original);await assert.rejects(execution.executeToolInvocation(issued));assert.equal(sideEffects.get(original.resource),1);
      const compensation=await writeInput(original.resource,original.agentRunId,issued.invocationId);await assert.rejects(service.authorizeToolInvocation(compensation));
      await reconciliation.reconcileToolInvocation({...issued,queryId:randomUUID()});assert.equal((await status(issued.invocationId)).status,'completed');
      const undo=await issueWrite(compensation);await execution.executeToolInvocation(undo);assert.equal(sideEffects.get(original.resource),0);
    });
    await db.update(s.toolRegistry).set({sideEffect:'READ',allowedActions:['read']}).where(eq(s.toolRegistry.id,toolId));
    await test('first concurrent Agent run authorizations share one atomic risk budget',async()=>{
      const run=randomUUID(),values=await Promise.all([authorize('normal',run,5),authorize('normal',run,5)]);
      assert.equal(values.filter(value=>value.disposition==='ALLOW').length,1);
      assert.equal(values.filter(value=>value.disposition==='BLOCK').length,1);
      const[budget]=await db.select().from(s.agentLifecycleBudgets).where(and(eq(s.agentLifecycleBudgets.agentRunId,run),eq(s.agentLifecycleBudgets.applicationId,scope.applicationId)));
      assert.equal(budget.consumedRiskBudget,5);assert.equal(budget.toolSteps,1);
    });
  } finally {
    server.close();server.closeAllConnections();await closeDatabaseConnection();
    writeFileSync(path.join(directory,'tool-execution-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),
      status:results.length===18?'PASS':'FAIL',isolatedDatabase:true,externalExecutor:'synthetic pinned-mTLS adapter',
      realThirdPartyCertification:false,requestBodiesStored:false,results},null,2));
  }
}
main().catch(error=>{console.error('TOOL_EXECUTION_INTEGRATION_FAILED',error instanceof Error?error.name:'unknown', error instanceof Error && error.cause && typeof error.cause==='object' && 'code' in error.cause ? error.cause.code : 'CHECK_FAILED');process.exitCode=1;});
