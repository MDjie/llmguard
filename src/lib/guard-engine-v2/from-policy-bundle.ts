import type { RuntimePolicyBundle } from '@/lib/policy-bundle/runtime';
import { buildDefaultDetectorDag } from './default-dag';
import { createGuardEngine } from './engine';
import {
  ContentSafetyIntentDetector,
  InsuranceComplianceDetector,
  PromptAttackDetector,
  ResourceAbuseDetector,
  StructuredDlpDetector,
} from './builtin-detectors';
import { ReasoningAttackDetector } from './reasoning-attack-detector';
import { RuleDetector } from './rule-detector';
import { SemanticClassifierDetector } from './semantic-classifier';

export function createEngineForPolicyBundle(
  bundle: RuntimePolicyBundle,
  hmacKey = process.env.CONTENT_HASH_KEY ?? '',
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
  const actionOverrides: Record<string, 'MASK' | 'REWRITE'> = {};
  const actionOverrideThresholds: Record<string, number> = {};
  for (const threshold of bundle.payload.thresholds) {
    const riskType = dimensionCodes.get(threshold.dimensionId);
    if (!riskType || (!threshold.autoMask && !threshold.autoRewrite)) continue;
    actionOverrides[riskType] = threshold.autoRewrite ? 'REWRITE' : 'MASK';
    actionOverrideThresholds[riskType] = threshold.warn;
  }
  return createGuardEngine(
    {
      id: bundle.payload.policyId,
      bundleId: bundle.id,
      warnThreshold,
      blockThreshold,
      failClosedOnRequiredDetectorFailure: true,
      actionOverrides,
      actionOverrideThresholds,
      detectorDag: bundle.payload.detectorDag
        ?? buildDefaultDetectorDag(bundle.payload.semanticClassifier),
    },
    [
      new PromptAttackDetector(),
      new ReasoningAttackDetector(),
      new StructuredDlpDetector(),
      new ResourceAbuseDetector(),
      new InsuranceComplianceDetector(),
      new ContentSafetyIntentDetector(),
      new RuleDetector(
        bundle.payload.rules,
        `policy-${bundle.payload.policyVersion}`,
        bundle.payload.exceptions,
      ),
      ...(bundle.payload.semanticClassifier
        ? [new SemanticClassifierDetector(bundle.payload.semanticClassifier)]
        : []),
    ],
    { hmacKey },
  );
}
