import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngineForPolicyBundle, preparePolicyBundleEngine } from '@/lib/guard-engine-v2/from-policy-bundle';
import { createProtectedContextFingerprint } from '@/lib/guard-engine-v2/protected-context';
import type { GuardRequest } from '@guardllm/contracts';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle/runtime';

const key='cache-evidence-key-with-at-least-32-bytes';
const bundle:RuntimePolicyBundle={id:'recipe-bundle',tenantId:'tenant-cache',applicationId:'app-cache',generation:1,payload:{schemaVersion:'1.0',policyId:'recipe-policy',policyVersion:1,dimensions:[],thresholds:[],exceptions:[],rules:[{id:'deny',riskType:'prompt_injection',pattern:'CACHE_DENY',matchType:'contains',caseSensitive:true,score:1,mandatoryDeny:true}],detectorDag:{version:'cache-test',maximumCostUnits:2,nodes:['rules','protected-context-leak'].map(id=>({id,detectorId:id,tier:'L0',dependsOn:[],runCondition:'ALWAYS',timeoutMs:1000,maxAttempts:1,costUnits:1,failurePolicy:'FAIL_CLOSED'}))}}};
function request(text:string):GuardRequest{return {contractVersion:'1.0',context:{tenantId:'tenant-cache',applicationId:'app-cache',traceId:'cache-trace',requestId:'cache-request',policyBundleId:bundle.id,direction:'OUTPUT_COMPLETE',absoluteDeadlineEpochMs:Date.now()+5000},content:{text}};}
afterEach(()=>vi.unstubAllEnvs());
describe('immutable policy recipe reuse',()=>{
  it('separates scope and content changes even when bundle ID is reused',()=>{
    const first=preparePolicyBundleEngine(bundle);expect(preparePolicyBundleEngine(bundle)).toBe(first);
    expect(preparePolicyBundleEngine({...bundle,applicationId:'other-app'})).not.toBe(first);
    expect(preparePolicyBundleEngine({...bundle,payload:{...bundle.payload,rules:[]}})).not.toBe(first);
    expect(Object.isFrozen(first.bundle.payload)).toBe(true);expect(Object.isFrozen(first.detectors)).toBe(true);
  });
  it('retains request-specific protected context while reusing the compiled recipe',async()=>{
    const fingerprint=createProtectedContextFingerprint({id:'private-system',kind:'SYSTEM_PROMPT',text:'Internal routing code cobalt river seven.',canaries:['cobalt river seven']},key);
    const protectedEngine=createEngineForPolicyBundle(bundle,key,[fingerprint],{deferOutputRecheck:true});
    const unrelatedEngine=createEngineForPolicyBundle(bundle,key,[],{deferOutputRecheck:true});
    const [protectedResult,unrelatedResult]=await Promise.all([protectedEngine.evaluate(request('The internal code is cobalt river seven.')),unrelatedEngine.evaluate(request('The internal code is cobalt river seven.'))]);
    expect(protectedResult.action).toBe('BLOCK');expect(unrelatedResult.action).toBe('ALLOW');
  });
  it('uses the new evidence key after rotation instead of a cached engine closure',async()=>{
    vi.stubEnv('CONTENT_HASH_KEY',key);const first=createEngineForPolicyBundle(bundle);await first.evaluate(request('CACHE_DENY'));
    const rotated='new-evidence-key-with-at-least-32-bytes';vi.stubEnv('CONTENT_HASH_KEY',rotated);
    const result=await createEngineForPolicyBundle(bundle).evaluate(request('CACHE_DENY'));
    const evidence=result.observations.find(item=>item.detectorId==='rules')?.evidence[0];
    expect(evidence?.contentHmac).toBe(createHmac('sha256',rotated).update('CACHE_DENY').digest('hex'));
  });
});
