import {afterEach,describe,it,expect,vi} from 'vitest';
import {judgeProfileSchema} from '@/lib/judge/profile';
import {qualityBindingDigest} from '@/lib/judge/profile-registry';
import {evaluateCoverageJudge} from '@/lib/guard-engine-v2/coverage-judge';
import {aggregateGuardDecision} from '@/lib/guard-engine-v2/aggregate';
import type {GuardDetectorContext} from '@/lib/guard-engine-v2/types';
import type {JudgeInvoker} from '@/lib/judge/router';
afterEach(()=>vi.unstubAllEnvs());
async function run(maxWindows:number,unsafeSecond=false){
 const p=judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'review-windows',role:'refiner',revision:1,tenantId:'t',applicationId:'a',displayName:'synthetic',enabled:true,mode:'ENFORCE',providerId:'p',providerType:'custom',baseUrl:'https://private.example/v1',modelId:'synthetic',deploymentMode:'private',dataBoundaryPolicyId:'p',authMode:'none',directions:['INPUT'],riskIds:['prompt_injection'],contextScope:'window',promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0',qualityEvidenceId:'review-windows',qualityValidUntil:'2099-01-01T00:00:00.000Z',maxInputChars:128,windowing:{maxWindows,overlapChars:0}});
 vi.stubEnv('JUDGE_QUALITY_APPROVALS_JSON',JSON.stringify([{evidenceId:p.qualityEvidenceId,profileBindingDigest:qualityBindingDigest(p),validUntil:p.qualityValidUntil,gateStatus:'PASS',datasetSha256:'a'.repeat(64),reviewApprovalRef:'synthetic-only'}]));
 const text='A'.repeat(128)+'B'.repeat(128);
 const ctx:GuardDetectorContext={request:{contractVersion:'1.0',context:{tenantId:'t',applicationId:'a',traceId:'trace-12345',requestId:'request-12345',direction:'INPUT',policyBundleId:'b',absoluteDeadlineEpochMs:Date.now()+10000},content:{text}},envelopes:[],views:[{id:'original',text,originSpans:Array.from(text,(_,start)=>({start,end:start+1}))}],signal:new AbortController().signal,evidenceHmac:()=> 'a'.repeat(64)};
 let index=0;
 const invoke:JudgeInvoker=async(_profile,request)=>{const unsafe=unsafeSecond&&index++===1;return{id:request.assessmentId,latencyMs:0,content:JSON.stringify({schemaVersion:'2.0',assessmentId:request.assessmentId,complete:true,assessments:[{riskId:'prompt_injection',verdict:unsafe?'UNSAFE':'SAFE',evidence:unsafe?[{start:0,end:5}]:[],counterEvidence:unsafe?[]:[{start:0,end:5}],reasonCode:unsafe?'UNSAFE_ACTION':'NEGATED_ACTION'}]})};};
 const observations=await evaluateCoverageJudge([p],ctx,{invoke,checkEndpoint:async()=>{}});
 return {observations,decision:aggregateGuardDecision({request:ctx.request,policy:{id:'p',bundleId:'b',warnThreshold:.5,blockThreshold:.8,decisionPolicyVersion:2,failClosedOnRequiredDetectorFailure:true,semanticDecisionMode:'coverage-v1',semanticCoverage:{requiredRiskIds:['prompt_injection']},judgeProfiles:[p]},observations,requiredDetectorFailures:[],latencyMs:0})};
}
describe('review evidence across semantic windows',()=>{
 it('retains every counter-evidence window with its exact source offsets',async()=>{
  const {observations,decision}=await run(2);expect(observations).toHaveLength(2);
  expect(observations.map(item=>item.evidence[0]?.start)).toEqual([0,128]);
  expect(new Set(observations.map(item=>item.assessmentId)).size).toBe(2);
  expect(observations.filter(item=>item.semanticCoverage==='COMPLETE')).toHaveLength(1);expect(decision.action).toBe('ALLOW');
 });
 it('retains partial evidence while refusing an incomplete coverage claim',async()=>{
  const {observations,decision}=await run(1);
  expect(observations.some(item=>item.evidence[0]?.start===0)).toBe(true);
  expect(observations.every(item=>item.semanticCoverage==='INCOMPLETE')).toBe(true);expect(decision.action).toBe('BLOCK');
 });
 it('retains counter-evidence alongside a confirmed unsafe window',async()=>{
  const {observations,decision}=await run(2,true);
  expect(observations.some(item=>item.reasonCode?.endsWith('_SAFE')&&item.evidence[0]?.start===0)).toBe(true);
  expect(observations.some(item=>item.reasonCode?.endsWith('_UNSAFE')&&item.evidence[0]?.start===128)).toBe(true);expect(decision.action).toBe('BLOCK');
 });
});
