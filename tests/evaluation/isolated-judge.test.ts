import { describe,expect,it,vi } from 'vitest';
import { evaluateIsolatedJudge } from '../../src/lib/evaluation/isolated-judge';
import { judgeProfileSchema } from '../../src/lib/judge/profile';
const profile=judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'p',revision:1,tenantId:'t',applicationId:'a',displayName:'test',providerId:'p',providerType:'custom',
  baseUrl:'https://private.example/v1',modelId:'test',deploymentMode:'private',dataBoundaryPolicyId:'test',authMode:'none',directions:['INPUT'],riskIds:['self_harm'],
  mode:'ENFORCE',enabled:true,maxAttempts:1,promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0'});
const row={caseId:'c',groupId:'g',sourceId:'synthetic',sourceLicense:'test',sourceHash:'a'.repeat(64),split:'development',text:'safe synthetic',expectedRiskIds:[],acceptableActions:['ALLOW'],annotationStatus:'needs_review'};
const budget={maximumCases:4,maximumCalls:1,maximumReservedTokens:10000,totalTimeoutMs:2000,concurrency:1};
describe('isolated candidate model evaluation',()=>{
  it('can test an unqualified candidate without promoting it or publishing an enforce artifact',async()=>{
    const invoke=vi.fn(async(p:typeof profile,r:{assessmentId:string})=>({id:r.assessmentId,latencyMs:0,content:JSON.stringify({schemaVersion:'2.0',assessmentId:r.assessmentId,complete:true,assessments:[{riskId:'self_harm',verdict:'SAFE',evidence:[],reasonCode:'TEST'}]})}));
    const report=await evaluateIsolatedJudge([profile],[row],budget,{invoke,checkEndpoint:async()=>{}});
    expect(invoke.mock.calls[0][0].mode).toBe('SHADOW');expect(report.cases[0].status).toBe('COMPLETE');
    expect(report.productionEligible).toBe(false);expect(report.qualityStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(profile.mode).toBe('ENFORCE');
  });
  it('keeps budget-exhausted cases in the denominator with no model call',async()=>{
    const invoke=vi.fn(async()=>({id:'x',latencyMs:0,content:'bad'}));
    const report=await evaluateIsolatedJudge([profile],[row,{...row,caseId:'d'}],budget,{invoke,checkEndpoint:async()=>{}});
    expect(invoke).toHaveBeenCalledTimes(1);expect(report.cases.some(c=>c.status==='BUDGET_EXHAUSTED')).toBe(true);
  });
  it('never sends unauthorized cases to cloud candidates',async()=>{
    await expect(evaluateIsolatedJudge([{...profile,deploymentMode:'cloud',authMode:'bearer',secretRef:'key'}],[row],budget)).rejects.toThrow('EXTERNAL_DATA_NOT_AUTHORIZED');
  });
});
