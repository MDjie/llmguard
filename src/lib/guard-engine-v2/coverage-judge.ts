import { selectJudgeProfile, type JudgeProfile } from '@/lib/judge/profile';
import { runJudge, type JudgeInvoker } from '@/lib/judge/router';
import { textEvidence } from './evidence';
import { hasCompleteCoverage, planTextWindows } from './semantic-coverage';
import type { GuardDetectorContext, Observation } from './types';

export async function evaluateCoverageJudge(profiles:readonly JudgeProfile[],context:GuardDetectorContext,
  dependencies:{readonly invoke?:JudgeInvoker;readonly checkEndpoint?:(p:JudgeProfile)=>Promise<void>}):Promise<readonly Observation[]>{
  const primary=selectJudgeProfile(profiles,context.request.context);
  const refiner=selectJudgeProfile(profiles,context.request.context,'refiner');
  if(!primary&&!refiner)return[];
  const text=context.request.content.text??'';
  const view=context.views.find(v=>v.id==='original');
  const unknown=(reasonCode:string,riskType='semantic_coverage'):Observation=>({
    detectorId:'configurable-judge',detectorVersion:'2.1.0',riskType,score:0,severity:'NONE',status:'NO_MATCH',evidence:[],
    decisionRole:'UNKNOWN',semanticCoverage:'INCOMPLETE',reasonCode,
  });
  if(!text||!view||(context.request.content.artifacts?.length??0)>0)return[unknown('SEMANTIC_MODALITY_UNSUPPORTED')];
  const deadline=Math.min(context.request.context.absoluteDeadlineEpochMs,Date.now()+(primary??refiner)!.totalTimeoutMs);
  const privateOnly=primary?.deploymentMode==='private'||refiner?.deploymentMode==='private'||
    context.envelopes.some(e=>e.sensitivityLabels.some(l=>/secret|credential|pii|confidential|personal|health|classification:[1-9]/iu.test(l)))||
    (context.previousObservations??[]).some(o=>o.status==='MATCH'&&/^(pii|credential|business.secret|sensitive|PRIVACY)/iu.test(o.riskType));
  const observations:Observation[]=[];
  const prior=context.previousObservations??[];
  const assess=async(profile:JudgeProfile,role:'base'|'refiner')=>{
    const plan=planTextWindows(text,profile.maxInputChars,profile.windowing?.maxWindows??1,profile.windowing?.overlapChars??0);
    const byRisk=new Map<string,Observation[]>();let completed=0;
    for(const [index,window] of plan.windows.entries()){
      if(context.signal.aborted||Date.now()>=deadline)break;
      const outcome=await runJudge(profiles,{...context.request.context,role,text:window.text,privateOnly,
        assessmentId:context.request.context.requestId.slice(0,90)+'-'+role+'-'+index,
        absoluteDeadlineEpochMs:deadline,signal:context.signal},dependencies);
      if(outcome.status!=='COMPLETE'||!outcome.response||!outcome.profile){
        const attempt=outcome.attempts.at(-1);
        const code=attempt&&/^[A-Z_]+$/u.test(attempt.status)?attempt.status:'UNKNOWN';
        observations.push({...unknown(('SEMANTIC_'+role.toUpperCase()+'_'+code).slice(0,100)),
          ...(outcome.profileDigest?{configurationDigest:outcome.profileDigest}:{}),...(outcome.profile?{modelVersion:outcome.profile.modelId}:{}),
          assessmentId:context.request.context.requestId.slice(0,90)+'-'+role+'-'+index});continue;
      }
      completed++;
      for(const assessment of outcome.response.assessments){
        const unsafe=assessment.verdict==='UNSAFE';
        const enforced=outcome.profile.mode==='ENFORCE';
        const item:Observation={
          detectorId:'configurable-judge',detectorVersion:'2.1.0',riskType:assessment.riskId,score:unsafe?1:0,scoreMeaning:'POLICY',
          severity:unsafe?'HIGH':'NONE',status:unsafe&&enforced?'MATCH':'NO_MATCH',
          ...(enforced?{decisionRole:unsafe?'CONFIRMED_RISK' as const:'CLEARED' as const}:{}),
          semanticCoverage:'INCOMPLETE',assessmentId:outcome.response.assessmentId,
          modelVersion:(outcome.reportedModel??outcome.profile.modelId).slice(0,256),configurationDigest:outcome.profileDigest,
          reasonCode:'SEMANTIC_'+role.toUpperCase()+'_'+outcome.profile.mode+'_'+assessment.verdict,
          evidence:assessment.evidence.map(e=>textEvidence(context,view,window.start+e.start,window.start+e.end,text.slice(window.start+e.start,window.start+e.end),'[redacted]')),
        };
        byRisk.set(assessment.riskId,[...(byRisk.get(assessment.riskId)??[]),item]);
      }
    }
    const complete=plan.complete&&completed===plan.windows.length&&(plan.windows.length===1||profile.contextScope==='window');
    for(const risk of profile.riskIds){
      const items=byRisk.get(risk)??[];
      const unsafe=items.filter(o=>o.reasonCode?.endsWith('_UNSAFE'));
      if(unsafe.length)observations.push(...unsafe.map(o=>({...o,semanticCoverage:complete?'COMPLETE' as const:'INCOMPLETE' as const})));
      else if(complete&&items.length===plan.windows.length)observations.push({...items[0],semanticCoverage:'COMPLETE'});
      else observations.push(unknown(plan.complete?'SEMANTIC_CONTEXT_NOT_FULLY_ASSESSED':'SEMANTIC_WINDOW_BUDGET_EXCEEDED',risk));
    }
  };
  // A qualified explicit classifier may already have fulfilled the base role.
  if(primary&&!primary.riskIds.every(risk=>hasCompleteCoverage(prior,risk)))await assess(primary,'base');
  const combined=[...prior,...observations];
  const conflict=(risk:string)=>combined.some(o=>o.riskType===risk&&o.decisionRole==='CLEARED')&&combined.some(o=>o.riskType===risk&&o.decisionRole==='CONFIRMED_RISK');
  if(refiner&&refiner.riskIds.some(risk=>!hasCompleteCoverage(combined,risk)||conflict(risk)))await assess(refiner,'refiner');
  // Confirmed risk is monotone: later clearance never erases mandatory/confirmed findings.
  return observations;
}
