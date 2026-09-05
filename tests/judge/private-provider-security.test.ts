import { afterEach, describe, expect, it, vi } from 'vitest';
import { judgeProfileSchema, selectJudgeProfile } from '../../src/lib/judge/profile';
import { assertJudgeQuality, privateEndpointApproved, qualityBindingDigest } from '../../src/lib/judge/profile-registry';
import { callProviderChat, resolveProviderSecret } from '../../src/lib/providers/chat';
import { safeFetchJson } from '../../src/lib/egress';
import { runJudge } from '../../src/lib/judge/router';
import { selftestJudge } from '../../src/lib/judge/selftest';
import { judgeWireSchema } from '../../src/lib/judge/response-schema';
vi.mock('../../src/lib/egress',async importOriginal=>({...await importOriginal<typeof import('../../src/lib/egress')>(),safeFetchJson:vi.fn()}));
const p=()=>judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'main',revision:1,tenantId:'t',applicationId:'a',displayName:'test',providerId:'p',providerType:'custom',baseUrl:'https://private.example/v1',modelId:'customer-model',deploymentMode:'private',dataBoundaryPolicyId:'private',authMode:'none',directions:['INPUT'],riskIds:['self_harm'],enabled:true,promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0'});
const approval=()=>JSON.stringify([{tenantId:'t',applicationId:'a',dataBoundaryPolicyId:'private',baseUrl:'https://private.example/v1',approvalRef:'operator-ticket'}]);
const response=(id:string)=>JSON.stringify({schemaVersion:'2.0',assessmentId:id,complete:true,assessments:[{riskId:'self_harm',verdict:'SAFE',evidence:[],reasonCode:'TEST'}]});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('private provider configuration and quality boundaries',()=>{
  it('sends explicit native response constraints and refuses schema mode without a schema',async()=>{
    vi.stubEnv('JUDGE_PRIVATE_ENDPOINT_APPROVALS_JSON',approval());
    vi.mocked(safeFetchJson).mockResolvedValue({model:'customer-model',choices:[{message:{content:response('bound-id')},finish_reason:'stop'}]});
    const connection={...p(),secretRef:null,apiKeyEncrypted:null,defaultModel:'customer-model'};
    const schema=judgeWireSchema('bound-id',['self_harm'],12);
    await callProviderChat(connection,[{role:'user',content:'synthetic'}],{authMode:'none',responseFormat:'json_schema',responseSchema:schema});
    expect(vi.mocked(safeFetchJson).mock.calls[0][0].body).toMatchObject({response_format:{type:'json_schema',json_schema:{strict:true,schema}}});
    await expect(callProviderChat(connection,[],{responseFormat:'json_schema'})).rejects.toThrow('requires a schema');
  });
  it('treats malformed private approval configuration as unapproved',()=>{expect(privateEndpointApproved(p(),'{bad')).toBe(false);});
  it.each(['deepseek','glm','qwen','kimi','ollama','openai_compatible','custom'])('supports explicit bearer authentication for %s',async providerType=>{
    const connection={...p(),providerType,secretRef:'secure-ref',apiKeyEncrypted:null,defaultModel:'m'};
    const secrets={put:vi.fn(),get:vi.fn(async()=>'synthetic-secret'),delete:vi.fn()};
    expect(await resolveProviderSecret(connection,secrets,'bearer')).toBe('synthetic-secret');expect(secrets.get).toHaveBeenCalledWith('secure-ref');
  });
  it('uses approved non-Ollama no-auth private endpoints through the provider configuration',async()=>{
    vi.stubEnv('JUDGE_PRIVATE_ENDPOINT_APPROVALS_JSON',approval());
    vi.mocked(safeFetchJson).mockResolvedValue({model:'customer-model',choices:[{message:{content:'pong'},finish_reason:'stop'}]});
    const connection={tenantId:'t',applicationId:'a',providerType:'custom',baseUrl:p().baseUrl,defaultModel:'customer-model',secretRef:null,apiKeyEncrypted:null,configJson:{deployment:{deploymentMode:'private',authMode:'none',dataBoundaryPolicyId:'private'}}};
    await callProviderChat(connection,[{role:'user',content:'synthetic ping'}],{temperature:null});
    expect(vi.mocked(safeFetchJson).mock.calls[0][0].headers).toBeUndefined();
    expect(vi.mocked(safeFetchJson).mock.calls[0][0].body).not.toHaveProperty('temperature');
    vi.stubEnv('JUDGE_PRIVATE_ENDPOINT_APPROVALS_JSON','[]');
    await expect(callProviderChat(connection,[{role:'user',content:'ping'}])).rejects.toThrow('No-auth requires an approved private endpoint');
  });
  it('does not select a higher-priority backup as the primary',async()=>{
    const main={...p(),fallbackProfileIds:['backup']};const backup={...p(),profileId:'backup',priority:999};
    const request={tenantId:'t',applicationId:'a',direction:'INPUT' as const,assessmentId:'test',text:'synthetic',privateOnly:true,absoluteDeadlineEpochMs:Date.now()+10000,signal:new AbortController().signal};
    expect(selectJudgeProfile([backup,main],request)?.profileId).toBe('main');
    const called:string[]=[];const result=await runJudge([backup,main],request,{checkEndpoint:async()=>{},invoke:async(profile)=>{called.push(profile.profileId);if(profile.profileId==='main')throw new Error('unavailable');return{id:'x',content:response('test'),latencyMs:0};}});
    expect(result.status).toBe('COMPLETE');expect(called).toEqual(['main','backup']);
  });
  it('invalidates quality approval when a behavior-affecting field changes',()=>{
    const profile={...p(),mode:'ENFORCE' as const,qualityEvidenceId:'evidence',qualityValidUntil:'2099-01-01T00:00:00Z'};
    const raw=JSON.stringify([{evidenceId:'evidence',profileBindingDigest:qualityBindingDigest(profile),validUntil:profile.qualityValidUntil,gateStatus:'PASS',datasetSha256:'a'.repeat(64),reviewApprovalRef:'independent-approval'}]);
    expect(()=>assertJudgeQuality(profile,Date.now(),raw)).not.toThrow();
    expect(()=>assertJudgeQuality({...profile,modelId:'changed-model'},Date.now(),raw)).toThrow('JUDGE_QUALITY_EVIDENCE_REQUIRED');
  });
  it('protocol selftest uses only synthetic content and never certifies model quality',async()=>{
    const invoke=vi.fn(async(_profile:ReturnType<typeof p>,r:{assessmentId:string;text:string})=>({id:'x',content:response(r.assessmentId),latencyMs:0}));
    const report=await selftestJudge(p(),new AbortController().signal,{invoke,checkEndpoint:async()=>{}});
    expect(report.protocolStatus).toBe('PASS');expect(report.qualityStatus).toBe('UNVERIFIED');expect(invoke.mock.calls[0][1].text).toContain('synthetic protocol test');
  });
});
