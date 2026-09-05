import type { GuardAction } from '@guardllm/contracts';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle/runtime';
import {
  CredentialOutputDetector,
  IllegalHarmfulOutputDetector,
  InsuranceOutputDetector,
  InternalDataOutputDetector,
  OUTPUT_ACTION_OVERRIDES,
  OUTPUT_ACTION_OVERRIDE_THRESHOLDS,
  PoliticalOutputDetector,
  PrivacyOutputDetector,
  SexualOutputDetector,
  applyOutputIntervention,
  recordOutputControlFailure,
  type OutputControlSecurityEventSink,
} from '@/lib/output-control';
import { buildDefaultDetectorDag } from './default-dag';
import { createGuardEngine } from './engine';
import {
  ContentSafetyIntentDetector,
  InsuranceComplianceDetector,
  PromptAttackDetector,
  ResourceAbuseDetector,
  StructuredDlpDetector,
} from './builtin-detectors';
import { ProtectedContextLeakDetector } from './protected-context';
import { ReasoningAttackDetector } from './reasoning-attack-detector';
import { RuleDetector } from './rule-detector';
import { SemanticClassifierDetector } from './semantic-classifier';
import { ConfigurableJudgeDetector } from './judge-detector';
import { withJudgeDetectorDag } from './semantic-routing';
import type { GuardDetector, GuardEngineDependencies } from './types';
import { projectContextDecision } from './context-projection';

export interface PolicyBundleEngineRuntimeOptions {
  readonly dlpTokenizationHmacKey?: string | Buffer;
  readonly outputSecurityEventSink?: OutputControlSecurityEventSink;
}

/** Shared production recipe. No qualification bypass or request-controlled override. */
export function preparePolicyBundleEngine(bundle:RuntimePolicyBundle) {
  const warnThreshold = bundle.payload.decisionPolicyVersion !== 2 && bundle.payload.thresholds.length > 0
    ? Math.min(...bundle.payload.thresholds.map((item) => item.warn))
    : 0.5;
  const blockThreshold = bundle.payload.decisionPolicyVersion !== 2 && bundle.payload.thresholds.length > 0
    ? Math.min(...bundle.payload.thresholds.map((item) => item.block))
    : 0.8;
  const dimensionCodes = new Map(
    bundle.payload.dimensions.map((dimension) => [dimension.id, dimension.code]),
  );
  const actionOverrides: Record<string, GuardAction> = { ...OUTPUT_ACTION_OVERRIDES };
  const actionOverrideThresholds: Record<string, number> = {
    ...OUTPUT_ACTION_OVERRIDE_THRESHOLDS,
  };
  for (const threshold of bundle.payload.thresholds) {
    const riskType = dimensionCodes.get(threshold.dimensionId);
    if (!riskType || (!threshold.autoMask && !threshold.autoRewrite)) continue;
    actionOverrides[riskType] = threshold.autoRewrite ? 'REWRITE' : 'MASK';
    actionOverrideThresholds[riskType] = threshold.warn;
  }
  const detectorDag = bundle.payload.detectorDag
    ?? withJudgeDetectorDag(buildDefaultDetectorDag(bundle.payload.semanticClassifier), bundle.payload.judgeProfiles, bundle.payload.decisionPolicyVersion);
  const protectedContextEnabled = detectorDag.nodes.some(
    (node) => node.detectorId === 'protected-context-leak',
  );
  const availableDetectors: GuardDetector[] = [
    new PromptAttackDetector(),
    ...(protectedContextEnabled ? [new ProtectedContextLeakDetector()] : []),
    new ReasoningAttackDetector(),
    new StructuredDlpDetector(),
    new ResourceAbuseDetector(),
    new InsuranceComplianceDetector(),
    new ContentSafetyIntentDetector(),
    new PoliticalOutputDetector(),
    new SexualOutputDetector(),
    new IllegalHarmfulOutputDetector(),
    new CredentialOutputDetector(),
    new PrivacyOutputDetector(),
    new InternalDataOutputDetector(),
    new InsuranceOutputDetector(),
    new RuleDetector(
      bundle.payload.rules,
      `policy-${bundle.payload.policyVersion}`,
      bundle.payload.exceptions,
      Date.now,
      bundle.payload.decisionPolicyVersion,
    ),
    ...(bundle.payload.semanticClassifier
      ? [new SemanticClassifierDetector(bundle.payload.semanticClassifier)]
      : []),
    ...(bundle.payload.judgeProfiles?.some(p=>p.enabled) ? [new ConfigurableJudgeDetector(bundle.payload.judgeProfiles,{},bundle.payload.semanticDecisionMode)] : []),
  ];
  // Older signed bundles carry an earlier explicit DAG. Keep them executable by
  // registering exactly the detector identities signed into that bundle.
  const referencedDetectorIds = new Set(detectorDag.nodes.map((node) => node.detectorId));
  const detectors = availableDetectors.filter((detector) => referencedDetectorIds.has(detector.id));
  if (detectors.length !== referencedDetectorIds.size) {
    throw new Error('GRD_POLICY_DETECTOR_REGISTRY_INCOMPLETE');
  }
  return {policy:{
      id: bundle.payload.policyId,
      decisionPolicyVersion: bundle.payload.decisionPolicyVersion,
      semanticDecisionMode:bundle.payload.semanticDecisionMode,
      semanticCoverage:bundle.payload.semanticCoverage,
      semanticClassifier:bundle.payload.semanticClassifier,
      judgeProfiles: bundle.payload.judgeProfiles,
      riskThresholds: Object.fromEntries(bundle.payload.thresholds.flatMap(t => { const risk = dimensionCodes.get(t.dimensionId); return risk ? [[risk,{warn:t.warn,block:t.block}]] : []; })),
      bundleId: bundle.id,
      policyVersion: String(bundle.payload.policyVersion),
      warnThreshold,
      blockThreshold,
      failClosedOnRequiredDetectorFailure: true,
      actionOverrides,
      actionOverrideThresholds,
      detectorDag,
    },detectors};
}
export function createEngineForPolicyBundle(
  bundle: RuntimePolicyBundle,
  hmacKey = process.env.CONTENT_HASH_KEY ?? '',
  protectedContextFingerprints: GuardEngineDependencies['protectedContextFingerprints'] = [],
  runtimeOptions: PolicyBundleEngineRuntimeOptions = {},
) {
  const {policy,detectors}=preparePolicyBundleEngine(bundle);
  const outputSecurityEventSink=runtimeOptions.outputSecurityEventSink??(process.env.NODE_ENV==='production'?recordOutputControlFailure:undefined);
  const baseEngine=createGuardEngine(policy,detectors,{hmacKey,protectedContextFingerprints});
  return {
    ...(baseEngine.contextEvaluationMode?{contextEvaluationMode:baseEngine.contextEvaluationMode}:{}),
    async evaluateContextual(combined:Parameters<typeof baseEngine.evaluate>[0],current:Parameters<typeof baseEngine.evaluate>[0]){
      const decision=projectContextDecision(await baseEngine.evaluate(combined),combined,current);
      return applyOutputIntervention(current,decision,bundle,{
        evidenceHmacKey:hmacKey,tokenizationHmacKey:runtimeOptions.dlpTokenizationHmacKey??process.env.DLP_TOKENIZATION_HMAC_KEY,
        evaluateRecheck:baseEngine.evaluate,securityEventSink:outputSecurityEventSink,
      });
    },
    async evaluate(request: Parameters<typeof baseEngine.evaluate>[0]) {
      const decision = await baseEngine.evaluate(request);
      return applyOutputIntervention(request, decision, bundle, {
        evidenceHmacKey: hmacKey,
        tokenizationHmacKey: runtimeOptions.dlpTokenizationHmacKey ??
          process.env.DLP_TOKENIZATION_HMAC_KEY,
        evaluateRecheck: baseEngine.evaluate,
        securityEventSink: outputSecurityEventSink,
      });
    },
  };
}
