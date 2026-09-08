import { randomUUID } from 'node:crypto';
import type { GuardAction, GuardDecision, GuardRequest } from '@guardllm/contracts';

const priority:Readonly<Record<GuardAction,number>>={ALLOW:0,WARN:1,MASK:2,REWRITE:3,SAFE_RESPONSE:3,REQUIRE_REVIEW:4,BLOCK:5};
/** Evaluate supplied text only; this module has no business-model/provider client. */
export async function evaluateSampleDirections(evaluate:(request:GuardRequest)=>Promise<GuardDecision>,request:GuardRequest,outputText:string|null) {
  const input=await evaluate(request);
  const output=outputText===null||outputText.length===0?null:await evaluate({...request,context:{...request.context,requestId:`eval-output-${randomUUID()}`,direction:'OUTPUT_COMPLETE',absoluteDeadlineEpochMs:Date.now()+30000},content:{text:outputText}});
  const decision=output&&priority[output.action]>priority[input.action]?output:input;
  return {decision,input,output,latencyMs:input.latencyMs+(output?.latencyMs??0),observations:[...input.observations,...(output?.observations??[])]};
}
