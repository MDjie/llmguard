import type { GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import type { StreamInspector } from './types';
import { selectJudgeProfile } from '@/lib/judge/profile';

export function createGuardStreamInspector(
  bundle: RuntimePolicyBundle,
  context: GuardRequest['context'],
): StreamInspector {
  const engine = createEngineForPolicyBundle(bundle);
  return async (text, inspection) => {
    if(bundle.payload.semanticDecisionMode==='coverage-v1'&&!inspection.final){
      const selected=selectJudgeProfile(bundle.payload.judgeProfiles??[],{...context,direction:'OUTPUT_CHUNK'});
      if(selected?.mode!=='ENFORCE'||selected.contextScope!=='window')return{action:'REQUIRE_REVIEW',decisionId:'stream-capability-unqualified',semanticCoverage:'INCOMPLETE'};
    }
    const decision = await engine.evaluate({
      contractVersion: '1.0',
      context: {
        ...context,
        requestId: `${context.requestId.slice(0,95)}-chunk-${inspection.sequence}`,
        direction: inspection.final?'OUTPUT_COMPLETE':'OUTPUT_CHUNK',
        absoluteDeadlineEpochMs:Math.min(context.absoluteDeadlineEpochMs,inspection.absoluteDeadlineEpochMs??context.absoluteDeadlineEpochMs),
        policyBundleId: bundle.id,
      },
      content: { text },
    });
    return {
      action: decision.action,
      decisionId: decision.decisionId,
      riskLevel: decision.riskLevel,
      semanticCoverage:decision.evidenceComplete&&!decision.degraded?'COMPLETE':'INCOMPLETE',
    };
  };
}
