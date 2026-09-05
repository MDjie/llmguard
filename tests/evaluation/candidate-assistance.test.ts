import { describe, expect, it } from 'vitest';
import { assistCandidates, materializeVariants } from '../../src/lib/evaluation/candidate-assistance';
import { prepareDataset } from '../../src/lib/evaluation/dataset-workbench';
import { judgeProfileSchema } from '../../src/lib/judge/profile';
const profile=judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'assist',revision:1,tenantId:'t',applicationId:'a',displayName:'Assist',enabled:true,mode:'SHADOW',providerId:'p',providerType:'ollama',baseUrl:'http://localhost:11434/v1',modelId:'test',deploymentMode:'private',dataBoundaryPolicyId:'private',authMode:'none',directions:['INPUT'],riskIds:['self_harm'],promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0'});
const records=prepareDataset(['a','b'].map((caseId,i)=>({caseId,groupId:caseId,sourceId:'s',sourceLicense:'internal',sourceHash:'a'.repeat(64),split:'development',text:i?'another separate example':'normal marker example',expectedRiskIds:[],acceptableActions:['ALLOW'],annotationStatus:'needs_review'})),'synthetic','author').records;
const budget={maxCalls:2,maxReservedTokens:100000,totalTimeoutMs:1000,privateOnly:true};
describe('bounded offline model assistance',()=>{
  it('resumes without duplicate calls and keeps generated variants unreviewed',async()=>{
    let calls=0;
    const invoke=async(_profile:typeof profile,_system:string,envelope:string)=>{calls++; const {caseId}=JSON.parse(envelope) as {caseId:string};return{id:'test',content:JSON.stringify({caseId,status:'candidate',notes:['suggestion'],variants:[{text:'harmless variation',reason:'contrast'}]}),latencyMs:1,reportedModel:'test',finishReason:'stop'};};
    const first=await assistCandidates({records,profile,task:'case-variants-1',budget:{...budget,maxCalls:1}},{invoke});
    expect(first.stopped).toBe('BUDGET');expect(calls).toBe(1);
    const second=await assistCandidates({records,profile,task:'case-variants-1',budget,checkpoint:first},{invoke});
    expect(second.items).toHaveLength(2);expect(calls).toBe(2);
    const variant=materializeVariants(records[0],second.items[0])[0];
    expect(variant.origin).toBe('synthetic');expect(variant.case.variantParentId).toBe(records[0].case.caseId);expect(variant.reviews).toHaveLength(0);
    expect(second.qualityStatus).toBe('INSUFFICIENT_EVIDENCE');
  });
  it('rejects cloud egress, changed checkpoints and auto approval output',async()=>{
    await expect(assistCandidates({records,profile:{...profile,providerType:'deepseek',deploymentMode:'cloud',baseUrl:'https://example.org',authMode:'bearer',secretRef:'key'},task:'safety-prelabel-1',budget})).rejects.toThrow('DATA_BOUNDARY');
    const result=await assistCandidates({records,profile,task:'safety-prelabel-1',budget},{invoke:async()=>({id:'bad',latencyMs:1,content:JSON.stringify({caseId:'a',status:'active',approvedBy:'model'})})});
    expect(result.items).toHaveLength(0);expect(result.failures).toHaveLength(2);
    await expect(assistCandidates({records,profile:{...profile,modelId:'changed'},task:'safety-prelabel-1',budget,checkpoint:result})).rejects.toThrow('CHECKPOINT_MISMATCH');
  });
  it('does not call model when reservation budget is insufficient',async()=>{
    const result=await assistCandidates({records,profile,task:'lexicon-curator-1',budget:{...budget,maxReservedTokens:1}},{invoke:async()=>{throw new Error('must not invoke');}});
    expect(result.calls).toBe(0);expect(result.stopped).toBe('BUDGET');
  });
});
