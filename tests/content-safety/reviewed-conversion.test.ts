import { generateKeyPairSync,createHash } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { convertLexiconSources,compileReviewedConversion } from '../../src/lib/policy-governance/lexicon-conversion';
import { appendReview,artifactDigest,workbenchRecordSchema } from '../../src/lib/evaluation/dataset-workbench';
import { canonicalJson } from '../../src/lib/policy-bundle/canonical';
import { dictionaryEntrySchema } from '../../src/contracts/http/policy-governance';
const content=JSON.stringify({canonical:'marker',risk_ids:['self_harm']});
const source={sourceId:'fixture',path:'fixture',format:'master-jsonl' as const,sha256:createHash('sha256').update(content).digest('hex'),license:'unit-test-only',authorizedUse:'dictionary_release' as const,riskMapping:{}};
const keys=['reviewer-1','reviewer-2'].map(reviewerId=>({reviewerId,...generateKeyPairSync('ed25519')}));
const registry=keys.map(k=>({reviewerId:k.reviewerId,publicKeyPem:k.publicKey.export({type:'spki',format:'pem'}).toString(),role:'reviewer',active:true}));
const identity={policyId:'p',dictionaryId:'dictionary',version:'1',layer:'APPLICATION' as const};
function fixture(){
  const conversion=convertLexiconSources([{source,content}]),candidate=conversion.candidates[0];
  const entry=dictionaryEntrySchema.parse({canonicalTerm:'marker',variants:['marker'],riskType:'self_harm',owner:'fixture',evidenceRequirement:'local context',positiveExamples:['marker risk'],negativeExamples:['ordinary']});
  let review=workbenchRecordSchema.parse({schemaVersion:'2.0',origin:'public',creatorId:'author',case:{caseId:'c',groupId:'g',sourceId:'fixture',sourceLicense:'unit-test-only',sourceHash:artifactDigest(candidate),split:'development',text:canonicalJson({candidateDigest:artifactDigest(candidate),entry}),expectedRiskIds:['self_harm'],acceptableActions:['BLOCK'],annotationStatus:'needs_review'}});
  for(const k of keys)review=appendReview(review,registry,k.privateKey.export({type:'pkcs8',format:'pem'}).toString(),{reviewerId:k.reviewerId,stage:'review',decision:'accept',label:{riskIds:['self_harm'],acceptableActions:['BLOCK'],evidence:[],reason:'Unit test only'},reviewedAt:'2026-09-05T00:00:00Z'});
  return{conversion,approval:{candidateId:candidate.candidateId,entry,review}};
}
describe('signed conversion release binding',()=>{
  it('compiles an independently signed exact entry with a permitted source',()=>{
    const {conversion,approval}=fixture();expect(()=>compileReviewedConversion(conversion,[approval],registry,identity)).not.toThrow();
  });
  it('rejects entry substitution after review',()=>{
    const {conversion,approval}=fixture();expect(()=>compileReviewedConversion(conversion,[{...approval,entry:{...approval.entry,mandatoryDeny:true}}],registry,identity)).toThrow('APPROVAL_REQUIRED');
  });
  it('rejects changed source licenses even if an attacker recomputes the conversion digest',()=>{
    const {conversion,approval}=fixture();const sources=conversion.sources.map(s=>({...s,license:'modified'}));
    expect(()=>compileReviewedConversion({...conversion,sources,digest:artifactDigest({sources,candidates:conversion.candidates})},[approval],registry,identity)).toThrow('SOURCE_BINDING_INVALID');
  });
  it('rejects synthetic signatures as real release approval',()=>{
    const {conversion,approval}=fixture();const changed={...approval.review,origin:'synthetic',reviews:[]};
    expect(()=>compileReviewedConversion(conversion,[{...approval,review:changed}],registry,identity)).toThrow('APPROVAL_REQUIRED');
  });
});
