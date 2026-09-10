import { runJudge, type JudgeInvoker } from '@/lib/judge/router';
import { selectJudgeProfile, type JudgeProfile } from '@/lib/judge/profile';
import type { GuardDetector, GuardDetectorContext, Observation } from './types';
import { textEvidence } from './evidence';
import { evaluateCoverageJudge } from './coverage-judge';

export class ConfigurableJudgeDetector implements GuardDetector {
  readonly id = 'configurable-judge';
  get version(){return this.semanticDecisionMode==='coverage-v1'?'2.1.0':'2.0.0';}
  readonly required = false;
  constructor(private readonly profiles: readonly JudgeProfile[], private readonly dependencies: { readonly invoke?: JudgeInvoker; readonly checkEndpoint?: (p:JudgeProfile)=>Promise<void> } = {},private readonly semanticDecisionMode?:'coverage-v1') {}
  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if(this.semanticDecisionMode==='coverage-v1')return evaluateCoverageJudge(this.profiles,context,this.dependencies);
    const selected = selectJudgeProfile(this.profiles, context.request.context);
    if (!selected) return [];
    const text = context.request.content.text ?? '';
    const privateOnly = selected.deploymentMode === 'private' ||
      context.envelopes.some(e => e.sensitivityLabels.some(label => /secret|credential|pii|confidential|personal|health|classification:[1-9]/i.test(label))) ||
      (context.previousObservations ?? []).some(o => o.status === 'MATCH' && /^(pii|credential|business.secret|sensitive|PRIVACY)/i.test(o.riskType));
    const base = {detectorId:this.id,detectorVersion:this.version,evidence:[],score:0,severity:'NONE' as const,status:'NO_MATCH' as const};
    if (!text || (context.request.content.artifacts?.length ?? 0) > 0) return [{...base,riskType:'semantic_coverage',decisionRole:selected.mode === 'ENFORCE' ? 'UNKNOWN' : undefined,semanticCoverage:'UNSUPPORTED',reasonCode:'JUDGE_TEXT_ONLY_COVERAGE'}];
    const result = await runJudge(this.profiles, {...context.request.context,text,privateOnly,assessmentId:context.request.context.requestId,signal:context.signal},this.dependencies);
    if (result.status !== 'COMPLETE' || !result.response || !result.profile) return [{
      ...base,riskType:'semantic_coverage',decisionRole:selected.mode === 'ENFORCE' ? 'UNKNOWN' : undefined,semanticCoverage:'INCOMPLETE',
      reasonCode:selected.mode === 'ENFORCE' ? 'JUDGE_ENFORCE_UNKNOWN' : 'JUDGE_SHADOW_UNKNOWN',
      configurationDigest:result.profileDigest,
      failMode: 'DEGRADED',
    }];
    const profile = result.profile; const view = context.views.find(v => v.id === 'original');
    if (!view) throw new Error('JUDGE_ORIGINAL_VIEW_REQUIRED');
    return result.response.assessments.map(a => ({
      detectorId:this.id,detectorVersion:this.version,riskType:a.riskId,
      score:a.verdict === 'UNSAFE' ? 1 : 0, scoreMeaning:'POLICY',
      severity:a.verdict === 'UNSAFE' ? 'HIGH' : 'NONE',
      status:profile.mode === 'ENFORCE' && a.verdict === 'UNSAFE' ? 'MATCH' : 'NO_MATCH',
      ...(profile.mode === 'ENFORCE' ? {decisionRole:a.verdict === 'UNSAFE' ? 'CONFIRMED_RISK' as const : 'CLEARED' as const} : {}),
      semanticCoverage:'COMPLETE',assessmentId:result.response!.assessmentId,
      modelVersion:(result.reportedModel ?? profile.modelId).slice(0,256),configurationDigest:result.profileDigest,
      reasonCode:(profile.mode === 'SHADOW' ? 'JUDGE_SHADOW_' : 'JUDGE_') + a.verdict,
      evidence:a.evidence.map(e => textEvidence(context,view,e.start,e.end,text.slice(e.start,e.end),'[redacted]')),
    }));
  }
}
