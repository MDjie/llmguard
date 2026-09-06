import { describe,expect,it } from 'vitest';
import { createGuardEngine, RuleDetector } from '../../src/lib/guard-engine-v2';
import type { GuardDetector } from '../../src/lib/guard-engine-v2';
const request=(text:string)=>({contractVersion:'1.0' as const,context:{tenantId:'t',applicationId:'a',traceId:'trace',requestId:'req',direction:'INPUT' as const,policyBundleId:'bundle',absoluteDeadlineEpochMs:Date.now()+5000},content:{text}});
const engine=(detectors:GuardDetector[])=>createGuardEngine({id:'p',bundleId:'bundle',warnThreshold:.5,blockThreshold:.8,failClosedOnRequiredDetectorFailure:true},detectors,{hmacKey:'0123456789abcdef0123456789abcdef'});
describe('explicit incomplete coverage',()=>{
  it('caps regex evidence at the limit instead of turning overflow into a hard block',async()=>{
    const rules=new RuleDetector([{id:'regex-flood',riskType:'example',pattern:'x',matchType:'regex',caseSensitive:true,score:.1}]);
    const result=await engine([rules]).evaluate(request('x '.repeat(101)));
    // 截断只影响证据数量，不改变判定：低分规则的证据超限不应升级为拦截
    expect(result.action).toBe('ALLOW');expect(result.degradationReasons).not.toContain('rules:unavailable');
    const flood=result.observations.find((o)=>o.ruleId==='regex-flood');
    expect(flood?.evidence).toHaveLength(100);
  });
  it('keeps scanning past floods so a tail mandatory risk is still caught',async()=>{const rules=new RuleDetector([{id:'flood',riskType:'example',pattern:'x',matchType:'contains',caseSensitive:true,score:.1},{id:'tail',riskType:'danger',pattern:'danger',matchType:'contains',caseSensitive:true,score:1,mandatoryDeny:true}]);const result=await engine([rules]).evaluate(request('x '.repeat(1100)+'danger'));expect(result.action).toBe('BLOCK');expect(result.observations.some((o)=>o.ruleId==='tail'&&o.reasonCode==='MANDATORY_DENY')).toBe(true);expect(result.degradationReasons).not.toContain('rules:unavailable');const flood=result.observations.find((o)=>o.ruleId==='flood');expect((flood?.evidence.length??0)).toBeLessThanOrEqual(100);});
  it('propagates returned detector ERROR statuses to fail-closed decisions',async()=>{const detector:GuardDetector={id:'required',version:'1',required:true,detect:async()=>[{detectorId:'required',detectorVersion:'1',riskType:'coverage',score:0,severity:'NONE',status:'ERROR',evidence:[]}]};const result=await engine([detector]).evaluate(request('ordinary'));expect(result.action).toBe('BLOCK');});
});
