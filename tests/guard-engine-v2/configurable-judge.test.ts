import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuardRequest, Observation } from '@guardllm/contracts';
import { judgeProfileSchema, type JudgeProfile } from '../../src/lib/judge/profile';
import { qualityBindingDigest } from '../../src/lib/judge/profile-registry';
import { ConfigurableJudgeDetector } from '../../src/lib/guard-engine-v2/judge-detector';
import { withJudgeDetectorDag } from '../../src/lib/guard-engine-v2/semantic-routing';
import { createGuardEngine, RuleDetector } from '../../src/lib/guard-engine-v2';
import { aggregateGuardDecision } from '../../src/lib/guard-engine-v2/aggregate';
import type { JudgeInvoker } from '../../src/lib/judge/router';

const profile=()=>judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'main',revision:1,tenantId:'tenant-a',applicationId:'app-a',displayName:'test',providerId:'provider',providerType:'custom',baseUrl:'https://private.example/v1',modelId:'customer-model',deploymentMode:'private',dataBoundaryPolicyId:'customer-private',authMode:'none',directions:['INPUT','OUTPUT_COMPLETE'],riskIds:['self_harm'],enabled:true,mode:'ENFORCE',qualityEvidenceId:'reviewed-evidence',qualityValidUntil:'2099-01-01T00:00:00Z',promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0'});
const request=(text='self harm in a discussion'):GuardRequest=>({contractVersion:'1.0',context:{traceId:'trace-1',requestId:'request-1',tenantId:'tenant-a',applicationId:'app-a',direction:'INPUT',absoluteDeadlineEpochMs:Date.now()+10000,policyBundleId:'bundle-1'},content:{text}});
const policy={id:'policy-1',bundleId:'bundle-1',warnThreshold:.5,blockThreshold:.8,failClosedOnRequiredDetectorFailure:true,decisionPolicyVersion:2 as const};
function approve(p:JudgeProfile){vi.stubEnv('JUDGE_QUALITY_APPROVALS_JSON',JSON.stringify([{evidenceId:p.qualityEvidenceId,profileBindingDigest:qualityBindingDigest(p),validUntil:p.qualityValidUntil,gateStatus:'PASS',datasetSha256:'a'.repeat(64),reviewApprovalRef:'independent-review-ticket'}]));}
const invoke=(verdict:'SAFE'|'UNSAFE'):JudgeInvoker=>async(p,r)=>({id:r.assessmentId,latencyMs:0,finishReason:'stop',content:JSON.stringify({schemaVersion:'2.0',assessmentId:r.assessmentId,complete:true,assessments:p.riskIds.map(riskId=>({riskId,verdict,evidence:verdict==='UNSAFE'?[{start:0,end:3}]:[],reasonCode:'TEST'}))})});
function engine(p:JudgeProfile, call:JudgeInvoker, mandatory=false,coverage=false){
  const rules=new RuleDetector([{id:'lexical',pattern:'self harm',riskType:'self_harm',matchType:'contains',caseSensitive:false,score:.99,mandatoryDeny:mandatory}],'4.0.0',[],Date.now,2);
  const dag=withJudgeDetectorDag({version:'test',maximumCostUnits:1,nodes:[{id:'rules',detectorId:'rules',tier:'L1',dependsOn:[],runCondition:'ALWAYS',timeoutMs:1000,maxAttempts:1,costUnits:1,failurePolicy:'FAIL_CLOSED'}]},[p],2);
  return createGuardEngine({...policy,...(coverage?{semanticDecisionMode:'coverage-v1' as const,semanticCoverage:{requiredRiskIds:p.riskIds}}:{}),judgeProfiles:[p],detectorDag:dag},[rules,new ConfigurableJudgeDetector([p],{invoke:call,checkEndpoint:async()=>{}},coverage?'coverage-v1':undefined)],{hmacKey:'0123456789abcdef0123456789abcdef'});
}
afterEach(()=>vi.unstubAllEnvs());
describe('V2 main-path configurable judge',()=>{
  it('uses one base semantic model with zero lexical hits in coverage mode',async()=>{
    const p=profile();approve(p);const call=vi.fn(invoke('SAFE'));const e=engine(p,call,false,true);
    expect((await e.evaluate(request('ordinary text'))).action).toBe('ALLOW');expect(call).toHaveBeenCalledTimes(1);expect(e.contextEvaluationMode).toBe('unified-v1');
  });
  it('checks overlapping windows and keeps tail evidence mapped to original text',async()=>{
    const p=judgeProfileSchema.parse({...profile(),maxInputChars:128,windowing:{maxWindows:4,overlapChars:24},contextScope:'window'});approve(p);
    const call:JudgeInvoker=async(p,r,s)=>{const pos=r.text.indexOf('TAIL');return pos<0?invoke('SAFE')(p,r,s):{id:r.assessmentId,latencyMs:0,content:JSON.stringify({schemaVersion:'2.0',assessmentId:r.assessmentId,complete:true,assessments:[{riskId:'self_harm',verdict:'UNSAFE',reasonCode:'TAIL',evidence:[{start:pos,end:pos+4}]}]})};};
    const result=await engine(p,call,false,true).evaluate(request('a'.repeat(270)+'TAIL'));
    expect(result.action).toBe('BLOCK');expect(result.observations.some(o=>o.evidence.some(e=>e.start===270&&e.end===274))).toBe(true);
  });
  it('does not claim full-context safety from independently safe windows',async()=>{
    const p=judgeProfileSchema.parse({...profile(),maxInputChars:128,windowing:{maxWindows:4,overlapChars:20}});approve(p);
    const result=await engine(p,invoke('SAFE'),false,true).evaluate(request('x'.repeat(200)));
    expect(result.action).toBe('BLOCK');expect(result.reasonCodes).toContain('SEMANTIC_COVERAGE_INCOMPLETE');
  });
  it('marks an uncovered tail UNKNOWN instead of silently allowing',async()=>{
    const p=judgeProfileSchema.parse({...profile(),maxInputChars:128,contextScope:'window',windowing:{maxWindows:1,overlapChars:20}});approve(p);
    const result=await engine(p,invoke('SAFE'),false,true).evaluate(request('x'.repeat(200)));
    expect(result.action).toBe('BLOCK');expect(result.evidenceComplete).toBe(false);
  });
  it('clears a high lexical candidate after complete semantic SAFE',async()=>{const p=profile();approve(p);const result=await engine(p,invoke('SAFE')).evaluate(request());expect(result.action).toBe('ALLOW');expect(result.observations.some(o=>o.decisionRole==='CANDIDATE')).toBe(true);expect(result.observations.some(o=>o.decisionRole==='CLEARED')).toBe(true);});
  it('detects unsafe meaning without any lexical match',async()=>{const p=profile();approve(p);const result=await engine(p,invoke('UNSAFE')).evaluate(request('indirect risk test'));expect(result.action).toBe('BLOCK');expect(result.observations.some(o=>o.decisionRole==='CONFIRMED_RISK')).toBe(true);});
  it('never invokes the judge to overrule mandatory denial',async()=>{const p=profile();approve(p);const call=vi.fn(invoke('SAFE'));const result=await engine(p,call,true).evaluate(request());expect(result.action).toBe('BLOCK');expect(call).not.toHaveBeenCalled();});
  it('does not treat malformed output as safe',async()=>{const p=profile();approve(p);const result=await engine(p,async()=>({id:'x',latencyMs:0,content:'safe'})).evaluate(request('normal'));expect(result.action).toBe('BLOCK');expect(result.degradationReasons).toContain('JUDGE_COVERAGE_INCOMPLETE');expect(result.evidenceComplete).toBe(false);});
  it('blocks an unsupported business scenario even without a lexical hit',async()=>{const p={...profile(),industries:['insurance']};approve(p);expect((await engine(p,invoke('SAFE')).evaluate(request('hello'))).action).toBe('BLOCK');});
  it('marks over-limit input as incomplete without sending a truncated prompt',async()=>{const p={...profile(),maxInputChars:128};approve(p);const call=vi.fn(invoke('SAFE'));const result=await engine(p,call).evaluate(request('a'.repeat(129)));expect(result.action).toBe('BLOCK');expect(call).not.toHaveBeenCalled();});
  it('requires operator-bound quality approval, not just a UI evidence ID',async()=>{const p=profile();vi.stubEnv('JUDGE_QUALITY_APPROVALS_JSON','[]');const call=vi.fn(invoke('SAFE'));expect((await engine(p,call).evaluate(request('hello'))).action).toBe('BLOCK');expect(call).not.toHaveBeenCalled();});
  it('requires review instead of silent allow when fail-closed is disabled',()=>{const result=aggregateGuardDecision({request:request('hello'),policy:{...policy,failClosedOnRequiredDetectorFailure:false},observations:[],requiredDetectorFailures:[],latencyMs:0});expect(result.action).toBe('REQUIRE_REVIEW');});
  it('keeps per-risk thresholds independent and duplicate evidence does not add scores',()=>{
    const o:Observation={detectorId:'entity',detectorVersion:'1',riskType:'entity.email',status:'MATCH',score:.6,severity:'MEDIUM',evidence:[]};
    const p={...policy,decisionPolicyVersion:2 as const,riskThresholds:{'entity':{warn:.4,block:.9},'unrelated':{warn:.1,block:.2}}};
    // A complete SAFE judge covers its own configured risk only, not entity.email.
    const safe:Observation={...o,detectorId:'configurable-judge',riskType:'self_harm',score:0,status:'NO_MATCH',decisionRole:'CLEARED',semanticCoverage:'COMPLETE'};
    const result=aggregateGuardDecision({request:request(),policy:{...p,judgeProfiles:[profile()]},observations:[o,o,safe],requiredDetectorFailures:[],latencyMs:0});expect(result.action).toBe('WARN');
  });
});
