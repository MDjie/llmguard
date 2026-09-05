import { describe, expect, it } from 'vitest';
import { judgeProfileSchema, selectJudgeProfile, validateJudgeProfileSet } from '../../src/lib/judge/profile';
import { runJudge } from '../../src/lib/judge/router';
import { privateEndpointApproved } from '../../src/lib/judge/profile-registry';
const profile = (type = 'qwen') => judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'main',revision:1,tenantId:'tenant-a',applicationId:'app-a',displayName:'Private model',providerId:'provider',providerType:type,baseUrl:'https://private.example/v1',modelId:'customer-model',deploymentMode:'private',dataBoundaryPolicyId:'client-a',authMode:'none',directions:['INPUT'],riskIds:['self_harm'],enabled:true,promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0'});
const request = () => ({tenantId:'tenant-a',applicationId:'app-a',direction:'INPUT' as const,assessmentId:'case-1',text:'normal text',privateOnly:true,absoluteDeadlineEpochMs:Date.now()+60000,signal:new AbortController().signal});
const safe = JSON.stringify({schemaVersion:'2.0',assessmentId:'case-1',complete:true,assessments:[{riskId:'self_harm',verdict:'SAFE',evidence:[],reasonCode:'BENIGN'}]});
describe('single-customer configurable judge routing', () => {
  it.each(['deepseek','glm','qwen','kimi','ollama','openai_compatible','custom'])('uses the same strict contract for %s',async type => {
    const result = await runJudge([profile(type)],request(),{checkEndpoint:async()=>{},invoke:async()=>({id:'x',content:safe,latencyMs:0})});
    expect(result.status).toBe('COMPLETE');
  });
  it('selects a business-specific model without mixing application scopes', () => {
    const main = profile(); const industry = {...main,profileId:'insurance',priority:10,industries:['insurance']};
    expect(selectJudgeProfile([main,industry],{...request(),industry:'insurance'})?.profileId).toBe('insurance');
    expect(selectJudgeProfile([main],{...request(),applicationId:'other'})).toBeUndefined();
  });
  it('requires an approved endpoint rather than a model brand', () => {
    expect(privateEndpointApproved(profile('ollama'), '[]')).toBe(false);
    expect(privateEndpointApproved(profile(),JSON.stringify([{tenantId:'tenant-a',applicationId:'app-a',dataBoundaryPolicyId:'client-a',baseUrl:'https://private.example/v1',approvalRef:'ops-ticket'}]))).toBe(true);
  });
  it('rejects private-to-cloud fallback before any request', () => {
    const p = {...profile(),fallbackProfileIds:['backup']};
    const backup = {...profile('deepseek'),profileId:'backup',deploymentMode:'cloud' as const,authMode:'bearer' as const,secretRef:'ref'};
    expect(()=>validateJudgeProfileSet([p,backup])).toThrow('JUDGE_FALLBACK_SCOPE_INVALID');
  });
  it.each(['', 'safe', '{}', safe.replace('SAFE','UNKNOWN'), safe.replace('self_harm','other')])('rejects malformed or incomplete response',async content => {
    const result = await runJudge([profile()],request(),{checkEndpoint:async()=>{},invoke:async()=>({id:'x',content,latencyMs:0})});
    expect(result.status).toBe('UNKNOWN');
  });
  it('bounds uncooperative model calls', async () => {
    const result = await runJudge([{...profile(),perAttemptTimeoutMs:50,totalTimeoutMs:50}], request(), {checkEndpoint:async()=>{},invoke:()=>new Promise(()=>{})});
    expect(result.status).toBe('UNKNOWN');
    expect(result.attempts).toHaveLength(1);
  });
});
