import {judgeTaskContext, validateScopedRefutation, adjudicationDigest, type RefinementProposal} from '@/lib/judge/harness';
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
  const proposals:RefinementProposal[]=[];
  const refuted=new Map<string,string>();
  const prior=context.previousObservations??[];
  const assess=async(profile:JudgeProfile,role:'base'|'refiner')=>{
    const inputBudget=profile.promptTemplateVersion==='guard-judge-3.0'?Math.max(128,profile.maxInputChars-8192):profile.maxInputChars;
    const plan=planTextWindows(text,inputBudget,profile.windowing?.maxWindows??1,profile.windowing?.overlapChars??0);
    const byRisk=new Map<string,Observation[]>();let completed=0;
    for(const [index,window] of plan.windows.entries()){
      if(context.signal.aborted||Date.now()>=deadline)break;
      const taskContext=judgeTaskContext(context,window);
      const scopedProposals=proposals.filter(item=>item.contextDigest===taskContext.sourceDigest&&item.evidence.every(e=>e.start>=window.start&&e.end<=window.end)).map(item=>({...item,evidence:item.evidence.map(e=>({start:e.start-window.start,end:e.end-window.start}))}));
      const outcome=await runJudge(profiles,{...context.request.context,role,text:window.text,privateOnly,taskContext,proposals:role==='refiner'?scopedProposals:undefined,
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
        const relevant=scopedProposals.filter(proposal=>proposal.riskId===assessment.riskId);
        const allRelevant=proposals.filter(proposal=>proposal.riskId===assessment.riskId);
        const mayClear=role!=='refiner'||allRelevant.length===0||Boolean(outcome.profile.adjudicationMode&&relevant.length===allRelevant.length&&relevant.every(proposal=>validateScopedRefutation(window.text,proposal,assessment.counterEvidence??[],assessment.reasonCode)));
        const item:Observation={
          detectorId:'configurable-judge',detectorVersion:'2.1.0',riskType:assessment.riskId,score:unsafe?1:0,scoreMeaning:'POLICY',
          severity:unsafe?'HIGH':'NONE',status:unsafe&&enforced?'MATCH':'NO_MATCH',
          ...(enforced?{decisionRole:unsafe?(role==='base'&&outcome.profile.adjudicationMode?'CANDIDATE' as const:'CONFIRMED_RISK' as const):mayClear?'CLEARED' as const:'UNKNOWN' as const}:{}),
          semanticCoverage:'INCOMPLETE',assessmentId:outcome.response.assessmentId,
          modelVersion:(outcome.reportedModel??outcome.profile.modelId).slice(0,256),configurationDigest:outcome.profileDigest,
          reasonCode:!unsafe&&!mayClear?'SEMANTIC_REFINER_REFUTATION_INVALID':'SEMANTIC_'+role.toUpperCase()+'_'+outcome.profile.mode+'_'+assessment.verdict,
          evidence:(role==='refiner'&&!unsafe?(assessment.counterEvidence??[]):assessment.evidence).map(e=>textEvidence(context,view,window.start+e.start,window.start+e.end,text.slice(window.start+e.start,window.start+e.end),'[redacted]')),
        };
        if(enforced&&unsafe&&role==='base'&&outcome.profile.adjudicationMode) proposals.push({riskId:assessment.riskId,contextDigest:taskContext.sourceDigest,evidence:assessment.evidence.map(e=>({start:e.start+window.start,end:e.end+window.start}))});
        if(enforced&&!unsafe&&mayClear&&role==='refiner'&&outcome.profile.adjudicationMode){
          for(const proposal of scopedProposals.filter(p=>p.riskId===assessment.riskId)){
            if(validateScopedRefutation(window.text,proposal,assessment.counterEvidence??[],assessment.reasonCode)) refuted.set(proposal.riskId,adjudicationDigest(proposal,assessment.counterEvidence??[],outcome.profileDigest??''));
          }
        }
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
      // Keep other assessed windows for authorized review without giving a partial
      // window its own complete-coverage claim or changing the aggregate verdict.
      const published=unsafe.length?unsafe:complete&&items.length===plan.windows.length?[items[0]]:[];
      observations.push(...items.filter(item=>!published.includes(item)&&item.evidence.length>0)
        .map(item=>({...item,semanticCoverage:'INCOMPLETE' as const})));
    }
  };
  // A qualified explicit classifier may already have fulfilled the base role.
  if(primary&&!primary.riskIds.every(risk=>hasCompleteCoverage(prior,risk)))await assess(primary,'base');
  const combined=[...prior,...observations];
  const conflict=(risk:string)=>combined.some(o=>o.riskType===risk&&o.decisionRole==='CLEARED')&&combined.some(o=>o.riskType===risk&&o.decisionRole==='CONFIRMED_RISK');
  if(refiner&&refiner.riskIds.some(risk=>!hasCompleteCoverage(combined,risk)||conflict(risk)||proposals.some(p=>p.riskId===risk)))await assess(refiner,'refiner');
  // Only this invocation's unconfirmed base proposals can be refuted. Prior/mandatory risk remains monotone.
  return observations.map(observation=>{
    const receipt=refuted.get(observation.riskType);
    if(receipt&&observation.decisionRole==='CANDIDATE'&&observation.reasonCode==='SEMANTIC_BASE_ENFORCE_UNSAFE') return {...observation,status:'NO_MATCH' as const,decisionRole:'CLEARED' as const,score:0,reasonCode:'SCOPED_REFUTATION_'+receipt};
    return observation;
  });
}
