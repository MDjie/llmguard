import { describe,expect,it } from 'vitest';
import { summarizeEvaluation,comparePairedRuns } from '../../src/lib/evaluation/optimization-report';
import { detectionCaseSchema } from '../../src/lib/evaluation/optimization-dataset';
import { artifactDigest } from '../../src/lib/evaluation/dataset-workbench';
const cases=Array.from({length:4},(_,i)=>detectionCaseSchema.parse({caseId:'c'+i,groupId:'g'+Math.floor(i/2),sourceId:'test',sourceLicense:'synthetic',sourceHash:'a'.repeat(64),split:'test',text:'case '+i,expectedRiskIds:i<2?['self_harm']:[],acceptableActions:i<2?['BLOCK']:['ALLOW'],annotationStatus:'needs_review'}));
const run={schemaVersion:'2.0',kind:'detection-evaluation-run',variant:'H1',datasetDigest:artifactDigest(cases),bundleDigest:'b'.repeat(64),profileDigests:[],
  cases:cases.map(c=>({caseId:c.caseId,traceId:c.caseId,requestHash:artifactDigest(c),confirmedRiskIds:c.expectedRiskIds,action:c.acceptableActions[0],
    effect:'SAFE',complete:true,evidenceComplete:true,modelCalls:1,queueMs:1,serviceMs:2,totalMs:3,outcome:'COMPLETE',reasonCodes:[]}))};
describe('reproducible grouped safety evaluation',()=>{
  it('retains all variants but clusters confidence intervals by source family',()=>{
    const report=summarizeEvaluation(cases,run);expect(report.point.caseCount).toBe(4);expect(report.confidence.independentGroups).toBe(2);
    expect(report.point.risk.recall).toBe(1);expect(report.qualityStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(report).toEqual(summarizeEvaluation(cases,run));
  });
  it('keeps timeouts, unknowns and effects in denominator rather than deleting them',()=>{
    const changed={...run,cases:run.cases.map((r,i)=>i===0?{...r,complete:false,effect:'UNKNOWN',outcome:'TIMEOUT',action:'REQUIRE_REVIEW',confirmedRiskIds:[]}:r)};
    const report=summarizeEvaluation(cases,changed);expect(report.point.unknownRate).toBe(.25);expect(report.point.risk.fnr).toBe(.5);expect(report.performance.sampleCount).toBe(4);
  });
  it('rejects report substitutions and missing per-case rows',()=>{
    expect(()=>summarizeEvaluation(cases,{...run,cases:run.cases.slice(1)})).toThrow('BINDING_INVALID');
    expect(()=>summarizeEvaluation(cases,{...run,cases:run.cases.map(r=>({...r,requestHash:'0'.repeat(64)}))})).toThrow('CASE_BINDING_INVALID');
  });
  it('compares identical source families and traces without claiming significance',()=>{
    const changed={...run,cases:run.cases.map((r,i)=>i===0?{...r,effect:'UNSAFE',action:'ALLOW'}:r)};
    const comparison=comparePairedRuns(cases,changed,run);expect(comparison.improved).toBe(1);expect(comparison.regressed).toBe(0);
    expect(comparison.paired).toHaveLength(4);
  });
});
