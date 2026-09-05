import { afterEach,describe,expect,it,vi } from 'vitest';
import { assessSemanticGroundedness } from '../../src/lib/rag/semantic-groundedness';
import { judgeProfileSchema } from '../../src/lib/judge/profile';
import { qualityBindingDigest } from '../../src/lib/judge/profile-registry';
import type { JudgeInvoker } from '../../src/lib/judge/router';
import type { RagCandidate } from '../../src/lib/rag/flow';
const profile=judgeProfileSchema.parse({schemaVersion:'2.0',profileId:'p',revision:1,tenantId:'t',applicationId:'a',displayName:'grounding',providerId:'p',providerType:'custom',baseUrl:'https://private.example/v1',modelId:'test',deploymentMode:'private',dataBoundaryPolicyId:'test',authMode:'none',directions:['OUTPUT_COMPLETE'],riskIds:['factual_grounding'],role:'grounding',mode:'ENFORCE',enabled:true,maxAttempts:1,qualityEvidenceId:'fixture-only',qualityValidUntil:'2099-01-01T00:00:00Z',promptTemplateVersion:'guard-judge-2.0',adapterVersion:'guard-chat-adapter-2.0'});
const citation:RagCandidate={tenantId:'t',applicationId:'a',sourceId:'document',chunkId:'chunk',contentHash:'a'.repeat(64),sourceVersion:'v1',validUntilEpochMs:Date.parse('2099-01-01'),text:'The limit is ten.',classification:1,allowedRoles:[],allowedPrincipals:['reader'],state:'accepted',trustLevel:20,signature:'fixture'};
const input=()=>({profiles:[profile],scope:{tenantId:'t',applicationId:'a'},output:'The limit is ten.',citations:[citation],traceId:'test',deadline:Date.now()+2000});
function approve(){vi.stubEnv('JUDGE_QUALITY_APPROVALS_JSON',JSON.stringify([{evidenceId:profile.qualityEvidenceId,profileBindingDigest:qualityBindingDigest(profile),validUntil:profile.qualityValidUntil,gateStatus:'PASS',datasetSha256:'b'.repeat(64),reviewApprovalRef:'unit-test-only'}]));}
const invoke=(evidence?:{start:number;end:number}[]):JudgeInvoker=>async(p,r)=>({id:r.assessmentId,latencyMs:0,content:JSON.stringify({schemaVersion:'2.0',assessmentId:r.assessmentId,complete:true,assessments:[{riskId:'factual_grounding',verdict:evidence?'UNSAFE':'SAFE',evidence:evidence??[],reasonCode:'TEST'}]})});
afterEach(()=>vi.unstubAllEnvs());
describe('versioned evidence-only semantic grounding',()=>{
  it('requires a qualified grounding model and actual current sources',async()=>{
    const call=vi.fn(invoke());
    for(const changed of [{...input(),profiles:[]},{...input(),citations:[]},{...input(),citations:[{...citation,validUntilEpochMs:1}]}])expect((await assessSemanticGroundedness(changed,{invoke:call})).status).toBe('INSUFFICIENT_CONTEXT');
    expect(call).not.toHaveBeenCalled();
  });
  it('sends only scoped cited evidence and records model/source binding',async()=>{
    approve();const call=vi.fn(invoke());const result=await assessSemanticGroundedness(input(),{invoke:call,checkEndpoint:async()=>{}});
    expect(result.status).toBe('PASS');expect(result.sourceDigests).toHaveLength(1);expect(call.mock.calls[0][1].privateOnly).toBe(true);expect(JSON.parse(call.mock.calls[0][1].text).citations[0].sourceVersion).toBe('v1');
  });
  it('requires unsupported-claim evidence to point to the output, not the source quotation',async()=>{
    approve();const result=await assessSemanticGroundedness(input(),{invoke:invoke([{start:0,end:2}]),checkEndpoint:async()=>{}});expect(result.reasonCodes).toContain('RAG_GROUNDING_EVIDENCE_INVALID');
    expect((await assessSemanticGroundedness(input(),{invoke:invoke([{start:11,end:14}]),checkEndpoint:async()=>{}})).status).toBe('FAIL');
  });
  it('never substitutes lexical overlap for missing semantic qualification',async()=>{
    vi.stubEnv('JUDGE_QUALITY_APPROVALS_JSON','[]');const call=vi.fn(invoke());expect((await assessSemanticGroundedness(input(),{invoke:call,checkEndpoint:async()=>{}})).status).toBe('INSUFFICIENT_CONTEXT');expect(call).not.toHaveBeenCalled();
  });
});
