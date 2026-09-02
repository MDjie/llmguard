import type { GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle';
import type { StreamInspector } from './types';

export function createGuardStreamInspector(
  bundle: RuntimePolicyBundle,
  context: GuardRequest['context'],
): StreamInspector {
  const engine = createEngineForPolicyBundle(bundle);
  return async (text, inspection) => {
    const decision = await engine.evaluate({
      contractVersion: '1.0',
      context: {
        ...context,
        requestId: `${context.requestId}-chunk-${inspection.sequence}`,
        direction: 'OUTPUT_CHUNK',
        policyBundleId: bundle.id,
      },
      content: { text },
    });
    return {
      action: decision.action,
      decisionId: decision.decisionId,
      riskLevel: decision.riskLevel,
    };
  };
}
