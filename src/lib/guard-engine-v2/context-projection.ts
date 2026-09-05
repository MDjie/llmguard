import type { GuardDecision, GuardRequest } from './types';

/** Internal-only projection before output transformation; history must never become released output. */
export function projectContextDecision(decision:GuardDecision,combined:GuardRequest,current:GuardRequest):GuardDecision{
  const full=combined.content.text??'',text=current.content.text??'';
  const offset=full.length-text.length;
  if(offset<0||full.slice(offset)!==text||decision.transformedText!==undefined)throw new Error('CONTEXT_PROJECTION_INVALID');
  return {...decision,traceId:current.context.traceId,policyPath:[...decision.policyPath,'unified-session-context'],
    observations:decision.observations.map(o=>({...o,evidence:o.evidence.map(e=>{
      if(e.start===undefined||e.end===undefined)return e;
      if(e.start>=offset)return {...e,start:e.start-offset,end:e.end-offset};
      const historical={...e};delete historical.start;delete historical.end;
      return {...historical,viewId:'session_history'};
    })}))};
}
