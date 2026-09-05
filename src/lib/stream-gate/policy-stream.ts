import type { GuardRequest } from '@guardllm/contracts';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import { selectJudgeProfile } from '@/lib/judge/profile';
import { createGuardStreamInspector } from './guard-inspector';
import { gateSseStream } from './gate';
/** Node-side provider/gateway adapter. Unqualified incremental scenarios fall back to full buffering. */
export function gatePolicySseStream(source:AsyncIterable<Uint8Array|string>,bundle:RuntimePolicyBundle,context:GuardRequest['context'],
  options:{preferIncremental?:boolean;maxBufferedBytes:number;inspectionTimeoutMs:number;upstreamIdleTimeoutMs?:number;totalTimeoutMs?:number;abortUpstream:(error:Error)=>void;signal?:AbortSignal}){
  const profile=selectJudgeProfile(bundle.payload.judgeProfiles??[],{...context,direction:'OUTPUT_CHUNK'});
  const incremental=bundle.payload.semanticDecisionMode==='coverage-v1'&&options.preferIncremental===true&&
    profile?.mode==='ENFORCE'&&profile.contextScope==='window'&&bundle.payload.semanticCoverage?.requiredRiskIds.every(r=>profile.riskIds.includes(r));
  return gateSseStream(source,{mode:incremental?'chunk':'complete',holdbackChars:256,rollingWindowChars:Math.max(512,profile?.maxInputChars??16000),
    maxBufferedBytes:options.maxBufferedBytes,inspectionTimeoutMs:options.inspectionTimeoutMs,inspector:createGuardStreamInspector(bundle,context),
    upstreamIdleTimeoutMs:options.upstreamIdleTimeoutMs,totalTimeoutMs:options.totalTimeoutMs,
    requireSemanticCoverage:bundle.payload.semanticDecisionMode==='coverage-v1',requireUpstreamCompletion:true,abortUpstream:options.abortUpstream,signal:options.signal});
}
