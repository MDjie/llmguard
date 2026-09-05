import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { judgeProfileListSchema, type JudgeProfile } from '@/lib/judge/profile';
import { profileDigest } from '@/lib/judge/profile-registry';
import { runJudge, type JudgeInvoker } from '@/lib/judge/router';
import { detectionCaseSchema } from './optimization-dataset';
import { artifactDigest } from './dataset-workbench';
import { reserveJudgeTokens } from '@/lib/judge/token-reservation';

export const isolatedBudgetSchema=z.object({
  maximumCases:z.number().int().min(1).max(1000),maximumCalls:z.number().int().min(1).max(2000),
  maximumReservedTokens:z.number().int().positive().max(10000000),
  totalTimeoutMs:z.number().int().min(50).max(3600000),concurrency:z.number().int().min(1).max(32),
}).strict();
/** No database, binding, promotion, or public-request bypass. SHADOW is forced on every attempted model. */
export async function evaluateIsolatedJudge(rawProfiles:readonly unknown[],rawCases:readonly unknown[],rawBudget:unknown,
  dependencies:{invoke?:JudgeInvoker;checkEndpoint?:(p:JudgeProfile)=>Promise<void>;signal?:AbortSignal}={}){
  const configured=judgeProfileListSchema.parse(rawProfiles);if(!configured.length)throw new Error('EVALUATION_PROFILE_REQUIRED');
  const profiles=configured.map(p=>({...p,mode:'SHADOW' as const}));
  const cases=z.array(detectionCaseSchema).min(1).parse(rawCases);
  const budget=isolatedBudgetSchema.parse(rawBudget);
  if(cases.length>budget.maximumCases||new Set(cases.map(c=>c.caseId)).size!==cases.length)throw new Error('EVALUATION_CASE_BUDGET_OR_ID_INVALID');
  if(profiles.some(p=>p.deploymentMode==='cloud')&&cases.some(c=>!c.authorizedExternalUse))throw new Error('EVALUATION_EXTERNAL_DATA_NOT_AUTHORIZED');
  const started=Date.now(),deadline=started+budget.totalTimeoutMs,runId='isolated-'+randomUUID();
  let callsReserved=0,tokensReserved=0;
  const rows:Array<{caseId:string;groupId:string;traceId:string;status:string;confirmedRiskIds:string[];latencyMs:number;queueMs:number;attempts:Awaited<ReturnType<typeof runJudge>>['attempts'];profileDigest?:string;reportedModel?:string}>=[];
  let next=0;
  const worker=async()=>{
    while(next<cases.length){
      const c=cases[next++],queued=Date.now()-started,traceId=runId+'-'+artifactDigest(c.caseId).slice(0,8);
      const tokenReserve=Math.max(...profiles.map(p=>reserveJudgeTokens(p,c.text)));
      const attemptReserve=Math.max(...profiles.map(p=>p.maxAttempts));
      if(dependencies.signal?.aborted||Date.now()>=deadline||callsReserved+attemptReserve>budget.maximumCalls||tokensReserved+tokenReserve*attemptReserve>budget.maximumReservedTokens||c.modality!=='text'){
        rows.push({caseId:c.caseId,groupId:c.groupId,traceId,status:c.modality!=='text'?'UNSUPPORTED':'BUDGET_EXHAUSTED',confirmedRiskIds:[],latencyMs:Date.now()-started,queueMs:queued,attempts:[]});continue;
      }
      callsReserved+=attemptReserve;tokensReserved+=tokenReserve*attemptReserve;
      const primary=profiles.find(p=>(p.role??'base')==='base')??profiles[0];
      const outcome=await runJudge(profiles,{tenantId:primary.tenantId,applicationId:primary.applicationId,direction:c.direction,locale:c.locale,industry:c.industry,role:primary.role,
        text:c.text,privateOnly:primary.deploymentMode==='private'||!c.authorizedExternalUse,
        assessmentId:traceId,absoluteDeadlineEpochMs:deadline,signal:AbortSignal.any([AbortSignal.timeout(Math.max(1,deadline-Date.now())),...(dependencies.signal?[dependencies.signal]:[])])},dependencies);
      rows.push({caseId:c.caseId,groupId:c.groupId,traceId,status:outcome.status,confirmedRiskIds:outcome.response?.assessments.filter(a=>a.verdict==='UNSAFE').map(a=>a.riskId)??[],
        latencyMs:Date.now()-started,queueMs:queued,attempts:outcome.attempts,...(outcome.profileDigest?{profileDigest:outcome.profileDigest}:{}),...(outcome.reportedModel?{reportedModel:outcome.reportedModel}:{})});
    }
  };
  await Promise.all(Array.from({length:Math.min(budget.concurrency,cases.length)},worker));
  return {schemaVersion:'2.0',kind:'isolated-candidate-evaluation',runId,productionEligible:false,qualityStatus:'INSUFFICIENT_EVIDENCE',
    evaluatedAt:new Date().toISOString(),datasetDigest:artifactDigest(cases),configuredProfileDigests:configured.map(profileDigest),
    executedProfileDigests:profiles.map(profileDigest),budget,callsReserved,tokensReserved,wallTimeMs:Date.now()-started,
    cases:rows.sort((a,b)=>a.caseId.localeCompare(b.caseId)),digest:artifactDigest(rows.sort((a,b)=>a.caseId.localeCompare(b.caseId)))};
}
