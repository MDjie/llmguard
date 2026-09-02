import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import { createGuardEngine } from './engine';
import {
  InsuranceComplianceDetector,
  PromptAttackDetector,
  ResourceAbuseDetector,
  StructuredDlpDetector,
} from './builtin-detectors';
import { RuleDetector } from './rule-detector';

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
  return createGuardEngine(
    {
      id: bundle.payload.policyId,
      bundleId: bundle.id,
      warnThreshold,
      blockThreshold,
      failClosedOnRequiredDetectorFailure: true,
    },
    [
      new PromptAttackDetector(),
      new StructuredDlpDetector(),
      new ResourceAbuseDetector(),
      new InsuranceComplianceDetector(),
      new RuleDetector(
        bundle.payload.rules,
        `policy-${bundle.payload.policyVersion}`,
        bundle.payload.exceptions,
      ),
    ],
    { hmacKey },
  );
}
