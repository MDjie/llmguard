import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appendReview, exportDataset, prepareDataset, resolveAnnotation, type WorkbenchRecord, type ReviewerRegistry } from '../../src/lib/evaluation/dataset-workbench';
import { detectionCaseSchema } from '../../src/lib/evaluation/optimization-dataset';
const keys = ['alice','bob','carol'].map(reviewerId => ({ reviewerId, ...generateKeyPairSync('ed25519') }));
const registry: ReviewerRegistry = keys.map(k => ({ reviewerId:k.reviewerId, publicKeyPem:k.publicKey.export({type:'spki',format:'pem'}).toString(), role:k.reviewerId === 'carol' ? 'adjudicator' : 'reviewer', active:true }));
const sample = (caseId:string, text = 'ordinary engineering example with marker') => detectionCaseSchema.parse({ caseId, groupId:caseId, sourceId:'source', sourceLicense:'internal', sourceHash:'a'.repeat(64), split:'development', text, expectedRiskIds:[], acceptableActions:['ALLOW'], annotationStatus:'needs_review' });
const label = { riskIds:[], acceptableActions:['ALLOW' as const], evidence:[], reason:'Independent annotation' };
function review(record:WorkbenchRecord, actor:number, risk = false, stage:'review'|'adjudication'='review') {
  return appendReview(record,registry,keys[actor].privateKey.export({type:'pkcs8',format:'pem'}).toString(),{ reviewerId:keys[actor].reviewerId,stage,decision:'accept',label:risk ? {...label,riskIds:['self_harm'],acceptableActions:['BLOCK']} : label,reviewedAt:'2026-09-05T00:00:00.000Z' });
}
describe('independently signed dataset workbench',()=>{
  it('groups normalized, near duplicate and template families before splitting',()=>{
    const result=prepareDataset([sample('a'),sample('b','ordinary engineering example with marker!'),{...sample('c','a different sentence'),templateFamily:'family'}, {...sample('d','unrelated wording'),templateFamily:'family'}],'synthetic','author');
    expect(result.records[0].case.groupId).toBe(result.records[1].case.groupId);
    expect(result.records[2].case.groupId).toBe(result.records[3].case.groupId);
    expect(result.records.every(r=>r.case.annotationStatus==='needs_review')).toBe(true);
  });
  it('requires two independent signed labels and forbids synthetic gold',()=>{
    const record=prepareDataset([sample('a')],'synthetic','author').records[0];
    const reviewed=review(review(record,0),1);
    expect(resolveAnnotation(reviewed,registry).status).toBe('reviewed');
    expect(()=>exportDataset([reviewed],registry,'locked')).toThrow('LOCKED_DATASET');
  });
  it('exports real independently reviewed records with evidence',()=>{
    const record=prepareDataset([sample('a')],'customer','author').records[0];
    const result=exportDataset([review(review(record,0),1)],registry,'locked');
    expect(result.cases[0].annotationStatus).toBe('reviewed');
    expect(result.qualityStatus).toBe('NOT_EVALUATED');
  });
  it('rejects self review, repeated identity and tampered input',()=>{
    const record=prepareDataset([sample('a')],'customer','alice').records[0];
    expect(()=>review(record,0)).toThrow('INDEPENDENT_REVIEW');
    const independent={...record,creatorId:'author'};
    const first=review(independent,0);
    expect(()=>review(first,0)).toThrow('INDEPENDENT_REVIEW');
    expect(()=>resolveAnnotation({...first,case:{...first.case,text:'tampered'}},registry)).toThrow('REVIEW_SIGNATURE');
    expect(()=>resolveAnnotation(first,[registry[0],{...registry[0],reviewerId:'alias'}])).toThrow('IDENTITY_DUPLICATE');
  });
  it('requires a third authorized adjudicator for disagreement',()=>{
    const record=prepareDataset([sample('a')],'customer','author').records[0];
    const disputed=review(review(record,0),1,true);
    expect(resolveAnnotation(disputed,registry).status).toBe('disputed');
    expect(resolveAnnotation(review(disputed,2,false,'adjudication'),registry).status).toBe('reviewed');
    expect(()=>review(record,2,false,'adjudication')).toThrow('ADJUDICATION');
  });
  it('rejects empty data and missing lineage parents',()=>{
    expect(()=>prepareDataset([],'synthetic','author')).toThrow('SIZE');
    expect(()=>prepareDataset([{...sample('a'),variantParentId:'missing'}],'customer','author')).toThrow('PARENT');
  });
});
