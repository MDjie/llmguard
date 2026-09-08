import { describe,it,expect } from 'vitest';
import pack from '../../data/content-safety/lexicon/detection-repair-v1.candidate.json';
import { dictionaryManifestSchema } from '../../src/contracts/http/policy-governance';
import { dictionaryEntryMatches } from '../../src/lib/policy-governance/validation';
const manifest=dictionaryManifestSchema.parse(pack.manifest);
describe('candidate domain and finance pack engineering examples',()=>{
  it('remains explicitly unpublished and unqualified by human review',()=>{
    expect(pack.publicationState).toBe('DRAFT_ONLY');
    expect(pack.reviewState).toBe('INDEPENDENT_REVIEW_REQUIRED');
  });
  for(const entry of manifest.entries){
    it(entry.canonicalTermId+' pairs risk behavior with normal context',()=>{
      for(const text of entry.positiveExamples)expect(dictionaryEntryMatches(entry,text),text).toBe(true);
      for(const text of entry.negativeExamples)expect(dictionaryEntryMatches(entry,text),text).toBe(false);
    });
  }
});
