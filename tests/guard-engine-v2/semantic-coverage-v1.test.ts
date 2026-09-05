import { afterEach,describe,expect,it,vi } from 'vitest';
import { aggregateGuardDecision } from '../../src/lib/guard-engine-v2/aggregate';
import { planTextWindows } from '../../src/lib/guard-engine-v2/semantic-coverage';
import { SemanticClassifierDetector } from '../../src/lib/guard-engine-v2/semantic-classifier';
import { classifierBindingDigest } from '../../src/lib/guard-engine-v2/classifier-qualification';
import { projectContextDecision } from '../../src/lib/guard-engine-v2/context-projection';
import type { GuardDetectorContext,GuardRequest,SemanticClassifierSpec } from '../../src/lib/guard-engine-v2/types';
const request:GuardRequest={contractVersion:'1.0',context:{requestId:'r',traceId:'t',tenantId:'tenant',applicationId:'app',direction:'INPUT',policyBundleId:'b',absoluteDeadlineEpochMs:Date.now()+10000},content:{text:'ordinary'}};
const spec:SemanticClassifierSpec={detectorId:'independent-classifier',detectorVersion:'1',modelId:'safety',modelVersion:'v1',modelSha256:'sha256:'+'a'.repeat(64),
  quantization:'FP16',baseUrl:'http://127.0.0.1:12345',path:'/classify',providerType:'custom',mode:'ENFORCE',failurePolicy:'FAIL_CLOSED',timeoutMs:1000,batchSize:1,maximumRequestBytes:1024,maximumResponseBytes:4096,temperature:1,
  labels:[{label:'harm',riskType:'self_harm',severity:'HIGH',threshold:.8}],coverage:{tenantId:'tenant',applicationId:'app',directions:['INPUT'],locales:[],contextScope:'full',deploymentMode:'private',dataBoundaryPolicyId:'private',qualityEvidenceId:'e',qualityValidUntil:'2099-01-01T00:00:00Z'}};
const context:GuardDetectorContext={request,envelopes:[],views:[{id:'original',text:'ordinary',originSpans:Array.from({length:8},(_,i)=>({start:i,end:i+1}))}],signal:new AbortController().signal,evidenceHmac:()=> 'a'.repeat(64)};
function approve(){vi.stubEnv('SEMANTIC_CLASSIFIER_QUALITY_APPROVALS_JSON',JSON.stringify([{evidenceId:'e',bindingDigest:classifierBindingDigest(spec),validUntil:'2099-01-01T00:00:00Z',gateStatus:'PASS',datasetSha256:'b'.repeat(64),reviewApprovalRef:'independent'}]));
  vi.stubEnv('JUDGE_PRIVATE_ENDPOINT_APPROVALS_JSON',JSON.stringify([{tenantId:'tenant',applicationId:'app',baseUrl:spec.baseUrl,dataBoundaryPolicyId:'private',approvalRef:'test'}]));}
const policy={id:'p',bundleId:'b',warnThreshold:.5,blockThreshold:.8,failClosedOnRequiredDetectorFailure:true,decisionPolicyVersion:2 as const,semanticDecisionMode:'coverage-v1' as const,semanticCoverage:{requiredRiskIds:['self_harm']},semanticClassifier:spec};
const invoke=async()=>({modelId:spec.modelId,modelVersion:spec.modelVersion,modelSha256:spec.modelSha256,items:[{id:'original',labels:[{label:'harm',confidence:.1}]}]});
afterEach(()=>vi.unstubAllEnvs());
describe('coverage rather than dedicated judge identity',()=>{
  it('permits a qualified classifier alone and keeps old bundles unchanged',async()=>{
    approve();const observations=await new SemanticClassifierDetector(spec,{invoke}).detect(context);
    const args={request,policy,observations,requiredDetectorFailures:[],latencyMs:0};
    expect(aggregateGuardDecision(args).action).toBe('ALLOW');
    expect(aggregateGuardDecision({...args,policy:{...policy,semanticDecisionMode:undefined}}).action).toBe('BLOCK');
  });
  it('rejects unapproved calibration changes and missing labels',async()=>{
    approve();await expect(new SemanticClassifierDetector({...spec,temperature:2},{invoke}).detect(context)).rejects.toThrow('QUALITY_REQUIRED');
    await expect(new SemanticClassifierDetector(spec,{invoke:async()=>({...await invoke(),items:[{id:'original',labels:[]}]})}).detect(context)).rejects.toThrow('LABEL_COVERAGE_INCOMPLETE');
  });
  it('does not grant coverage to SHADOW or a different scope',async()=>{
    approve();const observations=await new SemanticClassifierDetector({...spec,mode:'SHADOW'},{invoke}).detect(context);
    expect(aggregateGuardDecision({request,policy,observations,requiredDetectorFailures:[],latencyMs:0}).action).toBe('BLOCK');
    await expect(new SemanticClassifierDetector(spec,{invoke}).detect({...context,request:{...request,context:{...request.context,locale:'bad',tenantId:'different'}}})).rejects.toThrow('SCOPE_UNSUPPORTED');
  });
  it('preserves surrogate pairs and reports incomplete windows',()=>{
    const text='😀'.repeat(100);const result=planTextWindows(text,31,20,5);expect(result.complete).toBe(true);
    expect(result.windows.every(w=>w.text===text.slice(w.start,w.end)&&w.start%2===0&&w.end%2===0)).toBe(true);
    expect(planTextWindows(text,31,1,5).complete).toBe(false);
  });
  it('projects current evidence and refuses already-transformed history',()=>{
    const decision=aggregateGuardDecision({request,policy,observations:[],requiredDetectorFailures:[],latencyMs:0});
    const combined={...request,content:{text:'historyordinary'}};
    expect(projectContextDecision(decision,combined,request).policyPath).toContain('unified-session-context');
    expect(()=>projectContextDecision({...decision,transformedText:'history ordinary'},combined,request)).toThrow('CONTEXT_PROJECTION_INVALID');
  });
});
