import { afterEach,describe,expect,it,vi } from 'vitest';
import { judgeProfileSchema,type JudgeProfile } from '../../src/lib/judge/profile';
import { qualityBindingDigest } from '../../src/lib/judge/profile-registry';
import { evaluateCoverageJudge } from '../../src/lib/guard-engine-v2/coverage-judge';
import { projectContextDecision } from '../../src/lib/guard-engine-v2/context-projection';
import { aggregateGuardDecision } from '../../src/lib/guard-engine-v2/aggregate';
import type { GuardDetectorContext } from '../../src/lib/guard-engine-v2/types';
import type { JudgeInvoker } from '../../src/lib/judge/router';
const base=judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'base',revision:1,tenantId:'t',applicationId:'a',displayName:'test',providerId:'p',providerType:'custom',baseUrl:'https://private.example/v1',modelId:'test',deploymentMode:'private',dataBoundaryPolicyId:'test',authMode:'none',directions:['INPUT'],riskIds:['self_harm'],mode:'ENFORCE',enabled:true,maxAttempts:1,qualityEvidenceId:'base-fixture',qualityValidUntil:'2099-01-01T00:00:00Z',promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0'});
const refiner:JudgeProfile={...base,profileId:'refiner',role:'refiner',qualityEvidenceId:'refiner-fixture'};
function context():GuardDetectorContext{return{request:{contractVersion:'1.0',context:{requestId:'r',traceId:'t',tenantId:'t',applicationId:'a',policyBundleId:'b',direction:'INPUT',absoluteDeadlineEpochMs:Date.now()+10000},content:{text:'ordinary'}},envelopes:[],views:[{id:'original',text:'ordinary',originSpans:Array.from({length:8},(_,i)=>({start:i,end:i+1}))}],signal:new AbortController().signal,evidenceHmac:()=> 'a'.repeat(64)};}
function approve(){vi.stubEnv('JUDGE_QUALITY_APPROVALS_JSON',JSON.stringify([base,refiner].map(p=>({evidenceId:p.qualityEvidenceId,profileBindingDigest:qualityBindingDigest(p),validUntil:p.qualityValidUntil,gateStatus:'PASS',datasetSha256:'a'.repeat(64),reviewApprovalRef:'unit-test-only'}))));}
const response:JudgeInvoker=async(p,r)=>({id:r.assessmentId,latencyMs:0,content:JSON.stringify({schemaVersion:'2.0',assessmentId:r.assessmentId,complete:true,assessments:[{riskId:'self_harm',verdict:'SAFE',evidence:[],reasonCode:'TEST'}]})});
afterEach(()=>vi.unstubAllEnvs());
describe('conditional refinement and contextual evidence',()=>{
  it('does not run a redundant refiner after complete base clearance',async()=>{
    approve();const call=vi.fn(response);await evaluateCoverageJudge([base,refiner],context(),{invoke:call,checkEndpoint:async()=>{}});expect(call).toHaveBeenCalledTimes(1);
  });
  it('refines missing coverage once within the exact shared base deadline',async()=>{
    approve();const call=vi.fn<JudgeInvoker>(async(p,r,s)=>p.profileId==='base'?{id:'bad',latencyMs:0,content:'invalid'}:response(p,r,s));
    const result=await evaluateCoverageJudge([base,refiner],context(),{invoke:call,checkEndpoint:async()=>{}});
    expect(call).toHaveBeenCalledTimes(2);expect(call.mock.calls[0][1].absoluteDeadlineEpochMs).toBe(call.mock.calls[1][1].absoluteDeadlineEpochMs);
    expect(result.some(o=>o.decisionRole==='CLEARED'&&o.semanticCoverage==='COMPLETE')).toBe(true);
  });
  it('maps current-only evidence without leaking historical offsets',()=>{
    const ctx=context(),current=ctx.request,combined={...current,content:{text:'historyordinary'}};
    const decision=aggregateGuardDecision({request:combined,policy:{id:'p',bundleId:'b',warnThreshold:.5,blockThreshold:.8,failClosedOnRequiredDetectorFailure:true},requiredDetectorFailures:[],latencyMs:0,observations:[]});
    const observation={detectorId:'d',detectorVersion:'1',riskType:'test',score:.9,severity:'HIGH' as const,status:'MATCH' as const,evidence:[{kind:'TEXT_SPAN' as const,start:7,end:10,viewId:'original',contentHmac:'a'.repeat(64)},{kind:'TEXT_SPAN' as const,start:0,end:3,viewId:'original',contentHmac:'b'.repeat(64)}]};
    const projected=projectContextDecision({...decision,observations:[observation]},combined,current);
    expect(projected.observations[0].evidence[0]).toMatchObject({start:0,end:3});expect(projected.observations[0].evidence[1]).not.toHaveProperty('start');expect(projected.observations[0].evidence[1].viewId).toBe('session_history');
  });
});
