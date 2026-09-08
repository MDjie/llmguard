import { describe,it,expect } from 'vitest';
import { collectReadiness,scorePocs,validateWeights } from '../../scripts/acceptance/v11-readiness.mjs';
describe('V1.1 release readiness',()=>{
 it('does not turn code paths or engineering tests into accepted capabilities',()=>{
  const result=collectReadiness({sourceCommit:'a'.repeat(40)});
  expect(result.acceptanceStatus).toBe('INCOMPLETE');expect(result.originalRequirements).toHaveLength(101);
  expect(result.items.find(item=>item.id==='V11-NATIVE-RELEASE').implementationStatus).toBe('PARTIAL');
  expect(result.items.every(item=>item.acceptanceStatus==='PENDING_EVIDENCE')).toBe(true);
  expect(result.pocScore.status).toBe('WEIGHTS_NOT_FROZEN');
 });
 it('keeps unverified POC weight in the total and rejects missing or invented weights',()=>{
  const pocs=[{id:'p1'},{id:'p2'}],weights={p1:60,p2:40};
  expect(scorePocs(pocs,weights,{p1:'VERIFIED_PASS',p2:'PENDING_EVIDENCE'})).toEqual({status:'INCOMPLETE',awardedLowerBound:60,unverifiedWeight:40});
  expect(()=>validateWeights({p1:100},pocs)).toThrow();
  expect(()=>validateWeights({p1:60,p2:30},pocs)).toThrow();
 });
 it('rejects reports signed for another source and preserves implementation gaps',()=>{
  const evidence={'V11-JOINT-GLM53':'engineering.json','V11-NATIVE-RELEASE':'engineering.json'};
  const verify=()=>({report:{bindings:{sourceCommit:'b'.repeat(40)}}});
  const result=collectReadiness({sourceCommit:'a'.repeat(40),evidence,publicKey:'test-public-key',verify});
  expect(result.items[0].acceptanceStatus).toBe('SOURCE_MISMATCH');
  const current=collectReadiness({sourceCommit:'b'.repeat(40),evidence,publicKey:'test-public-key',verify});
  expect(current.items.find(item=>item.id==='V11-NATIVE-RELEASE').acceptanceStatus).toBe('IMPLEMENTATION_INCOMPLETE');
 });
});
