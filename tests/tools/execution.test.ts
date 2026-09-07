import { describe, expect, it } from 'vitest';
import { canonicalJson as permitCanonicalJson } from '@/lib/policy-bundle';
import { sha256 } from '@/lib/gateway-runtime/protocol';
import { assertExecutionClaims } from '@/lib/tools/execution-claims';
import { executorConfigurationHash, parseToolExecutors, validateExecutorReceipt, type ToolExecutionRequest } from '@/lib/tools/executor';
import { signToolPermit, verifyToolPermit } from '@/lib/tools/permit';

const executor = { tenantId:'tenant', applicationId:'app', toolId:'tool', toolVersion:'1.0', definitionDigest:'d'.repeat(64),
  executorId:'isolated-executor', endpoint:'https://localhost:9443/execute', serverCertificateSha256:'a'.repeat(64),
  caFile:'/ca', certificateFile:'/client', keyFile:'/key', timeoutMs:30000, maximumResponseBytes:1048576 };
const parameters = { amount: 1e-8 };
const invocation = { id:'inv', tenantId:'tenant', applicationId:'app', principalId:'user', agentRunId:'run',
  toolId:'tool', toolVersion:'1.0', bundleId:'bundle', action:'read', resource:'/records/1',
  parametersHash:sha256(permitCanonicalJson(parameters)), actionIntent: { userGoal: 'read fixture' }, actionIntentHash:sha256(permitCanonicalJson({ userGoal: 'read fixture' })),
  approvalDecisionId:null, executorConfigurationHash:executorConfigurationHash(executor), permitExpiresAt:new Date(2000) };
const permit = { version:2 as const, invocationId:invocation.id, tenantId:invocation.tenantId, applicationId:invocation.applicationId,
  subjectId:invocation.principalId, agentRunId:invocation.agentRunId, toolId:invocation.toolId, toolVersion:invocation.toolVersion,
  bundleId:invocation.bundleId, action:invocation.action, resourceHash:sha256(invocation.resource),
  parametersHash:invocation.parametersHash, actionIntentHash:invocation.actionIntentHash,
  executorConfigurationHash:invocation.executorConfigurationHash, expiresAt:2000 };
describe('controlled tool execution', () => {
  it('requires unique operator-approved HTTPS executor bindings', () => {
    expect(parseToolExecutors(JSON.stringify([executor]))).toEqual([executor]);
    for (const endpoint of ['http://localhost/execute','https://user:secret@localhost/execute','https://localhost/execute?url=secret']) {
      expect(()=>parseToolExecutors(JSON.stringify([{...executor,endpoint}]))).toThrow();
    }
    expect(()=>parseToolExecutors(JSON.stringify([executor,executor]))).toThrow();
    expect(executorConfigurationHash({...executor,keyFile:'/rotated-key'})).not.toBe(executorConfigurationHash(executor));
  });
  it('rejects changed subject, tool version, scope, action, parameters, resource, approval and executor', () => {
    expect(()=>assertExecutionClaims(permit,invocation,'user',parameters,1000)).not.toThrow();
    const changes = [
      {tenantId:'other'}, {applicationId:'other'}, {principalId:'other'}, {agentRunId:'other'},
      {toolVersion:'2'}, {bundleId:'other'}, {action:'write'}, {resource:'/records/2'},
      {actionIntent: { userGoal: 'changed' }}, {compensatesInvocationId:'forged'},
      {parametersHash:'f'.repeat(64)}, {actionIntentHash:'f'.repeat(64)}, {approvalDecisionId:'unapproved'},
      {executorConfigurationHash:'f'.repeat(64)}, {permitExpiresAt:new Date(3000)},
    ];
    for (const change of changes) expect(()=>assertExecutionClaims(permit,{...invocation,...change},'user',parameters,1000)).toThrow();
    expect(()=>assertExecutionClaims(permit,invocation,'other',parameters,1000)).toThrow();
    expect(()=>assertExecutionClaims(permit,invocation,'user',{amount:2},1000)).toThrow();
    expect(()=>assertExecutionClaims(permit,invocation,'user',parameters,2000)).toThrow();
  });
  it('binds executor receipts to the exact request and result', () => {
    const body:ToolExecutionRequest={protocolVersion:'1.0',invocationId:'inv',tenantId:'tenant',applicationId:'app',
      subjectId:'user',agentRunId:'run',toolId:'tool',toolVersion:'1',action:'read',resource:'/x',parameters:{},
      parametersHash:'a'.repeat(64),actionIntentHash:'b'.repeat(64),bundleId:'bundle',definitionDigest:'d'.repeat(64),
      executorId:'executor',deadlineEpochMs:40000};
    const receipt={protocolVersion:'1.0',invocationId:'inv',tenantId:'tenant',applicationId:'app',executorId:'executor',
      toolId:'tool',toolVersion:'1',requestDigest:'c'.repeat(64),resultDigest:sha256('safe'),status:'SUCCEEDED',result:'safe',completedAtEpochMs:20000};
    expect(validateExecutorReceipt(receipt,body,'c'.repeat(64),20000).result).toBe('safe');
    for (const change of [{result:'changed'},{tenantId:'other'},{requestDigest:'e'.repeat(64)},{completedAtEpochMs:80000},{executorId:'forged'}]) {
      expect(()=>validateExecutorReceipt({...receipt,...change},body,'c'.repeat(64),20000)).toThrow();
    }
  });
  it('supports the deployed key alias and refuses conflicting key definitions', () => {
    const env = { TOOL_PERMIT_SIGNING_KEY:'isolated-test-signing-key-at-least-32-bytes' };
    expect(verifyToolPermit(signToolPermit(permit,env),env,1000)).toEqual(permit);
    expect(()=>signToolPermit(permit,{...env,TOOL_PERMIT_KEY:'different-test-key-at-least-32-bytes'})).toThrow(/ambiguous/);
  });
});
