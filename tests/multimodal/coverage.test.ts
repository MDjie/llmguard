import { describe,it,expect } from 'vitest';
import { assessAnalysisCoverage,type AnalysisCoverage } from '../../src/lib/multimodal/coverage';
import { parsePdfPageCount } from '../../services/media-analyzer/src/document-image';
const coverage:AnalysisCoverage={artifactSha256:'a'.repeat(64),modality:'DOCUMENT',state:'COMPLETE',expectedUnits:10,processedUnits:10,analyzerVersion:'test-model-v1',reasonCodes:[]};
const request={tenantId:'t',applicationId:'a',requiredRiskIds:['self_harm'],coverage,artifactSha256:'a'.repeat(64)};
const registry=JSON.stringify([{tenantId:'t',applicationId:'a',analyzerVersion:'test-model-v1',modality:'DOCUMENT',riskIds:['self_harm'],validUntil:'2099-01-01T00:00:00Z',datasetSha256:'b'.repeat(64),approvalRef:'fixture-only',gateStatus:'PASS'}]);
describe('modality completeness is distinct from extraction success',()=>{
  it('requires artifact-, model-, scope- and quality-bound coverage',()=>{
    expect(assessAnalysisCoverage(request,registry).complete).toBe(true);
    expect(assessAnalysisCoverage({...request,tenantId:'different'},registry).complete).toBe(false);
    expect(assessAnalysisCoverage({...request,artifactSha256:'b'.repeat(64)},registry).complete).toBe(false);
    expect(assessAnalysisCoverage(request,'[]').complete).toBe(false);
  });
  it('never calls sampled frames or missing units complete',()=>{
    expect(assessAnalysisCoverage({...request,coverage:{...coverage,state:'SAMPLED'}},registry).complete).toBe(false);
    expect(assessAnalysisCoverage({...request,coverage:{...coverage,processedUnits:9}},registry).complete).toBe(false);
    expect(assessAnalysisCoverage({...request,coverage:{...coverage,reasonCodes:['LOW_CONFIDENCE']}},registry).complete).toBe(false);
  });
  it('rejects PDF over-limit tails, unknown and ambiguous page counts before rendering',()=>{
    expect(parsePdfPageCount('Pages: 10\n',10)).toBe(10);
    expect(()=>parsePdfPageCount('Pages: 11\n',10)).toThrow('PAGE_LIMIT');
    expect(()=>parsePdfPageCount('Pages: 1\nPages: 10\n',10)).toThrow('PAGE_LIMIT');
    expect(()=>parsePdfPageCount('Encrypted: yes\n',10)).toThrow('PAGE_LIMIT');
  });
});
