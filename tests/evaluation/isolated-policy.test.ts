import { describe,expect,it,vi } from 'vitest';
import { evaluateIsolatedPolicy } from '../../src/lib/evaluation/isolated-policy';
import { judgeProfileSchema } from '../../src/lib/judge/profile';
const profile=judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'p',revision:1,tenantId:'t',applicationId:'a',displayName:'test',providerId:'p',providerType:'custom',baseUrl:'https://private.example/v1',modelId:'test',deploymentMode:'private',dataBoundaryPolicyId:'test',authMode:'none',directions:['INPUT'],riskIds:['self_harm'],mode:'ENFORCE',enabled:true,maxAttempts:1,promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0'});
const payload={schemaVersion:'1.0',policyId:'p',policyVersion:1,dimensions:[],rules:[{id:'keyword',riskType:'self_harm',pattern:'marker',matchType:'contains',caseSensitive:false,score:.99}],exceptions:[],thresholds:[],judgeProfiles:[profile],decisionPolicyVersion:2,semanticDecisionMode:'coverage-v1',semanticCoverage:{requiredRiskIds:['self_harm']}};
const row={caseId:'c',groupId:'g',sourceId:'synthetic',sourceLicense:'test',sourceHash:'a'.repeat(64),split:'development',text:'marker in a harmless quotation',expectedRiskIds:[],acceptableActions:['ALLOW'],annotationStatus:'needs_review'};
const budget={maximumCases:4,maximumCalls:4,maximumReservedTokens:50000,totalTimeoutMs:5000,concurrency:2};
const invoke=vi.fn(async(p:typeof profile,r:{assessmentId:string})=>({id:r.assessmentId,latencyMs:0,content:JSON.stringify({schemaVersion:'2.0',assessmentId:r.assessmentId,complete:true,assessments:p.riskIds.map(riskId=>({riskId,verdict:'SAFE',evidence:[],reasonCode:'TEST'}))})}));
describe('isolated full policy and ablation harness',()=>{
  it('runs actual rule/DAG/semantic/aggregate path with SHADOW wire profiles, without quality approval',async()=>{
    invoke.mockClear();const report=await evaluateIsolatedPolicy({payload,cases:[row],variant:'H1',budget,scope:{tenantId:'t',applicationId:'a'}},{invoke,checkEndpoint:async()=>{}});
    expect(report.run.cases[0].action).toBe('ALLOW');expect(report.run.cases[0].modelCalls).toBe(1);
    expect(report.traces[0].observations.some(o=>o.decisionRole==='CANDIDATE')).toBe(true);
    expect(invoke.mock.calls[0][0].mode).toBe('SHADOW');expect(report.productionEligible).toBe(false);expect(report.run.cases[0].effect).toBe('UNKNOWN');
    expect(profile.mode).toBe('ENFORCE');
  });
  it('separates B1 deterministic rules and S1 semantic ablations',async()=>{
    const run=async(variant:'B1'|'S1')=>evaluateIsolatedPolicy({payload,cases:[row],variant,budget,scope:{tenantId:'t',applicationId:'a'}},{invoke,checkEndpoint:async()=>{}});
    const b=await run('B1'),s=await run('S1');expect(b.run.cases[0].action).toBe('BLOCK');expect(b.run.cases[0].modelCalls).toBe(0);expect(s.run.cases[0].action).toBe('ALLOW');
  });
  it('keeps hard denies and exhausted samples in the report denominator',async()=>{
    const hard=await evaluateIsolatedPolicy({payload:{...payload,rules:payload.rules.map(r=>({...r,mandatoryDeny:true}))},cases:[row],variant:'S1',budget,scope:{tenantId:'t',applicationId:'a'}},{invoke,checkEndpoint:async()=>{}});
    expect(hard.run.cases[0].action).toBe('BLOCK');expect(hard.run.cases[0].modelCalls).toBe(0);
    const exhausted=await evaluateIsolatedPolicy({payload,cases:[row,{...row,caseId:'c2'}],variant:'H1',budget:{...budget,maximumCalls:1},scope:{tenantId:'t',applicationId:'a'}},{invoke,checkEndpoint:async()=>{}});
    expect(exhausted.calls).toBe(1);expect(exhausted.run.cases).toHaveLength(2);expect(exhausted.run.cases.some(c=>!c.complete)).toBe(true);
  });
  it('rejects an unrelated customer scope before any network call',async()=>{
    await expect(evaluateIsolatedPolicy({payload,cases:[row],variant:'H1',budget,scope:{tenantId:'different',applicationId:'a'}})).rejects.toThrow('SCOPE_MISMATCH');
  });
});
