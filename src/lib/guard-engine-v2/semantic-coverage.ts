import { z } from 'zod';
import { selectJudgeProfile } from '@/lib/judge/profile';
import type { GuardEnginePolicy, GuardRequest, Observation } from './types';

export const semanticCoveragePolicySchema=z.object({
  requiredRiskIds:z.array(z.string().min(1).max(128)).min(1).max(100),
}).strict().refine(value=>new Set(value.requiredRiskIds).size===value.requiredRiskIds.length,'DUPLICATE_COVERAGE_RISK');
export type SemanticCoveragePolicy=z.infer<typeof semanticCoveragePolicySchema>;

export function hasCompleteCoverage(observations:readonly Observation[],riskId:string):boolean {
  return observations.some(o=>o.riskType===riskId&&o.semanticCoverage==='COMPLETE'&&
    (o.decisionRole==='CLEARED'||o.decisionRole==='CONFIRMED_RISK'));
}
export function coverageGaps(policy:GuardEnginePolicy,request:GuardRequest,observations:readonly Observation[]):string[]{
  if(policy.semanticDecisionMode!=='coverage-v1')return[];
  const trusted=new Set<string>();
  for(const role of ['base','refiner'] as const){
    const p=selectJudgeProfile(policy.judgeProfiles??[],request.context,role);
    if(p?.mode==='ENFORCE')trusted.add('configurable-judge');
  }
  if(policy.semanticClassifier?.mode==='ENFORCE'&&policy.semanticClassifier.coverage)trusted.add(policy.semanticClassifier.detectorId);
  const accepted=observations.filter(o=>trusted.has(o.detectorId));
  const risks=policy.semanticCoverage?.requiredRiskIds??[];
  if(!risks.length)return['CONFIGURATION_MISSING'];
  // Structured/multimodal input cannot inherit coverage from an unrelated text field.
  if((request.content.artifacts?.length??0)>0)return['MODALITY_NOT_COVERED'];
  return risks.filter(risk=>!hasCompleteCoverage(accepted,risk));
}

export interface TextWindow {readonly start:number;readonly end:number;readonly text:string;}
/** UTF-16 offsets are preserved, including overlap and surrogate-pair boundaries. */
export function planTextWindows(text:string,maxChars:number,maxWindows:number,overlap:number){
  if(!Number.isInteger(maxChars)||maxChars<2||!Number.isInteger(maxWindows)||maxWindows<1||overlap<0||overlap>=maxChars/2)throw new Error('WINDOW_CONFIGURATION_INVALID');
  const windows:TextWindow[]=[];let start=0;
  while(start<text.length&&windows.length<maxWindows){
    let end=Math.min(text.length,start+maxChars);
    if(end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1]))end--;
    windows.push({start,end,text:text.slice(start,end)});
    if(end===text.length)break;
    start=end-overlap;
    if(/[\uDC00-\uDFFF]/u.test(text[start]))start--;
  }
  return {windows,complete:windows.at(-1)?.end===text.length,coveredEnd:windows.at(-1)?.end??0};
}
