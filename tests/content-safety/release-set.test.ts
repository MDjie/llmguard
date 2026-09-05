import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compileReleaseSet, verifyReleaseSetArtifact } from '../../src/lib/policy-governance/release-set';
import { canonicalJson } from '../../src/lib/policy-bundle/canonical';
const term=(n:number)=>({termId:'synthetic-'+n,status:'reviewed',sourceIds:['synthetic'],reviewEvidenceRef:'test-fixture-only-not-real-review',entry:{canonicalTerm:'MARKER_'+n,variants:['MARKER_'+n],riskType:'self_harm',matchType:'exact',owner:'test',evidenceRequirement:'exact-span',actionHint:'semantic_confirm',sourceMatchMode:'exact',positiveExamples:['MARKER_'+n],negativeExamples:['ordinary'],contextCases:[{caseId:'context-'+n,text:'Discuss MARKER_'+n,expectedRiskIds:[],acceptableActions:['ALLOW']}]}});
const input=(count=1)=>({schemaVersion:'1.0',policyId:'policy-1',dictionaryId:'synthetic-library',version:'1',layer:'APPLICATION',sources:[{sourceId:'synthetic',sha256:'a'.repeat(64),license:'synthetic-test-only',authorizedUse:'dictionary_release'}],terms:Array.from({length:count},(_,i)=>term(i))});
describe('independent dictionary release set',()=>{
  it('round-trips the transport artifact and rejects missing/reordered/mutated shards',()=>{
    const result=compileReleaseSet(input(501));
    expect(verifyReleaseSetArtifact(result)).toEqual(result);
    expect(()=>verifyReleaseSetArtifact({...result,shards:result.shards.slice(0,1)})).toThrow();
    expect(()=>verifyReleaseSetArtifact({...result,shards:[...result.shards].reverse()})).toThrow();
    expect(()=>verifyReleaseSetArtifact({...result,variantCount:1})).toThrow();
    expect(()=>verifyReleaseSetArtifact({...result,releaseSetDigest:'0'.repeat(64)})).toThrow();
  });
  it('rejects fake approval references and source changes even if a caller recomputes the root hash',()=>{
    const result=compileReleaseSet(input());
    expect(()=>verifyReleaseSetArtifact({...result,reviewEvidence:[]})).toThrow();
    expect(()=>verifyReleaseSetArtifact({...result,reviewEvidence:[...result.reviewEvidence,...result.reviewEvidence]})).toThrow();
    const {releaseSetDigest,activationStatus,...payload}=result;expect(releaseSetDigest).toMatch(/^[a-f0-9]{64}$/u);
    const changed={...payload,shards:[{...payload.shards[0],sha256:'a'.repeat(64)}]};
    expect(()=>verifyReleaseSetArtifact({...changed,activationStatus,releaseSetDigest:createHash('sha256').update(canonicalJson(changed)).digest('hex')})).toThrow();
  });
  it('enforces database-compatible version lengths and permits different scoped selectors',()=>{
    expect(()=>compileReleaseSet({...input(),version:'v'.repeat(65)})).toThrow();
    const source=input();
    expect(compileReleaseSet({...source,terms:[term(0),{...term(0),termId:'contextual',entry:{...term(0).entry,contexts:['medical']}}]}).termCount).toBe(2);
  });
  it('packs 10,000 synthetic terms into 20 stable shards without activation',()=>{const source=input(10000);const result=compileReleaseSet(source);expect(result.termCount).toBe(10000);expect(result.variantCount).toBe(10000);expect(result.shards).toHaveLength(20);expect(result.shards.every(s=>s.manifest.entries.length<=500)).toBe(true);expect(result.activationStatus).toBe('NOT_IMPORTED');expect(compileReleaseSet({...source,terms:[...source.terms].reverse()}).releaseSetDigest).toBe(result.releaseSetDigest);});
  it('preserves source, original matching mode, action hint, canonical ID and separate contextual cases',()=>{const result=compileReleaseSet(input());expect(result.shards[0].manifest.entries[0]).toMatchObject({canonicalTermId:'synthetic-0',sourceIds:['synthetic'],actionHint:'semantic_confirm',sourceMatchMode:'exact',negativeExamples:['ordinary'],contextCases:[{caseId:'context-0'}]});const{releaseSetDigest,activationStatus,...payload}=result;expect(activationStatus).toBe('NOT_IMPORTED');expect(createHash('sha256').update(canonicalJson(payload)).digest('hex')).toBe(releaseSetDigest);});
  it('refuses candidates, unknown sources and duplicate selectors',()=>{const source=input();expect(()=>compileReleaseSet({...source,terms:[{...source.terms[0],status:'candidate'}]})).toThrow();expect(()=>compileReleaseSet({...source,sources:[]})).toThrow();expect(()=>compileReleaseSet({...source,terms:[term(0),{...term(0),termId:'other'}]})).toThrow('RELEASE_SELECTOR_CONFLICT');});
});
