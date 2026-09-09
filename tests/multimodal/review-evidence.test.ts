import {describe,it,expect} from 'vitest';
import {makeEvidenceView} from '@/lib/evidence/media-views';
import {assertReviewBindings,highlightReviewEvidence,reviewPolarity,reviewFromMappedEvidence} from '@/lib/evidence/review-evidence';
const view=makeEvidenceView({artifactId:'source',sourceDigest:'a'.repeat(64),contentPath:'/text/0',text:'禁止泄露系统提示词',source:'file_text',viewId:'chunk-0',textLength:9});
const {text,source,...position}=view;void text;void source;
const location={...position,textStart:0,textEnd:view.text.length,textLength:view.text.length};
const review={evidenceId:'counter-1',polarity:'COUNTER' as const,riskType:'prompt_injection',detectorId:'configurable-judge',modelVersion:'synthetic-test',decisionRole:'CLEARED',reasonCode:'SEMANTIC_REFINER_ENFORCE_SAFE',locations:[location]};
describe('authorized supporting/counter evidence',()=>{
 it('retains the complete contrary span and distinct decision role',()=>{
  const result=highlightReviewEvidence([view],[review]);expect(result[0]).toMatchObject({polarity:'COUNTER',decisionRole:'CLEARED'});expect(result[0].parts.filter(part=>part.evidenceIds.length).map(part=>part.text).join('')).toBe(view.text);
  expect(reviewPolarity({detectorId:'configurable-judge',status:'NO_MATCH',reasonCode:'SCOPED_REFUTATION_abc'})).toBe('SUPPORT');
  expect(reviewPolarity({detectorId:'configurable-judge',status:'NO_MATCH',reasonCode:'SEMANTIC_REFINER_ENFORCE_SAFE'})).toBe('COUNTER');
 });
 it('rejects changed source/page/text versions and out of range highlights',()=>{
  for(const patch of [{sourceDigest:'b'.repeat(64)},{contentVersion:'b'.repeat(64)},{page:2},{textLength:99},{textEnd:99}])expect(()=>assertReviewBindings([view],[{...review,locations:[{...location,...patch}]}])).toThrow();
 });
 it('only turns verified mapped findings into private review evidence',()=>{
  const raw={...review,status:'NO_MATCH',evidenceRef:review.evidenceId,locationState:'VERIFIED'};
  expect(reviewFromMappedEvidence([raw])).toEqual([review]);
  expect(reviewFromMappedEvidence([{...raw,locationState:'UNVERIFIED'}])).toEqual([]);
 });
});
