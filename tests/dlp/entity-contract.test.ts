import { describe,it,expect } from 'vitest';
import { collectTransformEntities } from '../../src/lib/dlp/entity-contract';
import type { Observation } from '@guardllm/contracts';
const observation:Observation={detectorId:'structured-dlp',detectorVersion:'1',riskType:'pii.mobile',category:'pii.mobile',score:0.9,severity:'HIGH',status:'MATCH',decisionRole:'CONFIRMED_RISK',evidence:[{viewId:'original',start:0,end:11,contentHmac:'a'.repeat(64)}]};
describe('typed output DLP contract',()=>{
  it('accepts registered structured entities and deduplicates normalized evidence',()=>{
    expect(collectTransformEntities([observation,observation],11)).toHaveLength(1);
  });
  it('does not transform an untyped or candidate keyword match',()=>{
    expect(collectTransformEntities([{...observation,detectorId:'rules'},{...observation,decisionRole:'CANDIDATE'}],11)).toEqual([]);
  });
  it('rejects stale coordinates and unsupported entity categories',()=>{
    expect(()=>collectTransformEntities([observation],10)).toThrow('DLP_ENTITY_EVIDENCE_INVALID');
    expect(()=>collectTransformEntities([{...observation,category:'unknown'}],11)).toThrow('DLP_ENTITY_TYPE_UNSUPPORTED');
  });
});
