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
import type { GuardDetector, GuardEngineDependencies } from './types';

export interface PolicyBundleEngineRuntimeOptions {
  readonly dlpTokenizationHmacKey?: string | Buffer;
  readonly outputSecurityEventSink?: OutputControlSecurityEventSink;
}

export function createEngineForPolicyBundle(
  bundle: RuntimePolicyBundle,
  hmacKey = process.env.CONTENT_HASH_KEY ?? '',
  protectedContextFingerprints: GuardEngineDependencies['protectedContextFingerprints'] = [],
  runtimeOptions: PolicyBundleEngineRuntimeOptions = {},
) {
  const warnThreshold = bundle.payload.thresholds.length > 0
    ? Math.min(...bundle.payload.thresholds.map((item) => item.warn))
    : 0.5;
  const blockThreshold = bundle.payload.thresholds.length > 0
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
    ?? buildDefaultDetectorDag(bundle.payload.semanticClassifier);
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
    ),
    ...(bundle.payload.semanticClassifier
      ? [new SemanticClassifierDetector(bundle.payload.semanticClassifier)]
      : []),
  ];
  // Older signed bundles carry an earlier explicit DAG. Keep them executable by
  // registering exactly the detector identities signed into that bundle.
  const referencedDetectorIds = new Set(detectorDag.nodes.map((node) => node.detectorId));
  const detectors = availableDetectors.filter((detector) => referencedDetectorIds.has(detector.id));
  if (detectors.length !== referencedDetectorIds.size) {
    throw new Error('GRD_POLICY_DETECTOR_REGISTRY_INCOMPLETE');
  }
  const outputSecurityEventSink = runtimeOptions.outputSecurityEventSink ??
    (process.env.NODE_ENV === 'production' ? recordOutputControlFailure : undefined);
  const baseEngine = createGuardEngine(
    {
      id: bundle.payload.policyId,
      bundleId: bundle.id,
      policyVersion: String(bundle.payload.policyVersion),
      warnThreshold,
      blockThreshold,
      failClosedOnRequiredDetectorFailure: true,
      actionOverrides,
      actionOverrideThresholds,
      detectorDag,
    },
    detectors,
    { hmacKey, protectedContextFingerprints },
  );
  return {
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
