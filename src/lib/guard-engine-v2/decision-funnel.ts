import type { GuardDecision } from '@guardllm/contracts';
import { isConfirmedObservation } from './observation-role';
export function decisionFunnel(decision:GuardDecision) {
  const observations=decision.observations;
  const confirmed=observations.filter(isConfirmedObservation);
  const suppressed=observations.filter(o=>o.reasonCode==='CONTEXT_SUPPRESSED_OCCURRENCE');
  const candidates=observations.filter(o=>o.status==='MATCH'&&o.decisionRole==='CANDIDATE');
  const interventionFailed=decision.reasonCodes?.some(code=>/^DLP_TRANSFORM_(?:ENTITY_INVALID|EVIDENCE_MISSING)|^OUTPUT_RECHECK_(?:FAILED|UNAVAILABLE)/u.test(code))??false;
  const stage=interventionFailed?'INTERVENTION_FAILED':decision.degraded?'DETECTION_DEGRADED':
    confirmed.length?(decision.action==='BLOCK'?'CONFIRMED_BLOCK':'CONFIRMED_NONBLOCK'):
    candidates.length?'SIGNAL_UNRESOLVED':suppressed.length?'CONTEXT_SUPPRESSED':'NO_RAW_MATCH';
  return {stage,observations:observations.length,confirmed:confirmed.length,candidates:candidates.length,
    suppressed:suppressed.length,normalizationIncomplete:observations.some(o=>o.detectorId==='normalization'&&o.semanticCoverage==='INCOMPLETE'),
    transformType:decision.transform?.type??null,recheckRequired:Boolean(decision.transform?.recheckDecisionId || (decision.transform && ['MASK','REWRITE','SAFE_RESPONSE'].includes(decision.transform.type))),
    recheckDecisionId:decision.transform?.recheckDecisionId??null,
    rawModelOutputReleasable:['ALLOW','WARN'].includes(decision.action) && !decision.degraded && decision.degradationReasons.length === 0 && decision.evidenceComplete !== false && (!decision.failMode || decision.failMode === 'NORMAL'),
    transformedOutputAvailable:Boolean(decision.transformedText),enforcementTransportVerified:false};
}
