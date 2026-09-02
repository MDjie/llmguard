import { createHmac } from 'node:crypto';
import { aggregateGuardDecision } from './aggregate';
import { buildNormalizedViews } from './normalization';
import { observeGuardDecision } from '@/lib/observability/metrics';
import type {
  GuardDetector,
  GuardEngine,
  GuardEngineDependencies,
  GuardEnginePolicy,
  GuardRequest,
  Observation,
} from './types';

function failureObservation(
  detector: GuardDetector,
  status: 'TIMEOUT' | 'ERROR',
): Observation {
  return {
    detectorId: detector.id,
    detectorVersion: detector.version,
    riskType: 'detector_availability',
    score: 0,
    severity: 'NONE',
    evidence: [],
    status,
    reasonCode: status === 'TIMEOUT' ? 'DETECTOR_DEADLINE_EXCEEDED' : 'DETECTOR_FAILED',
  };
}

async function runBeforeDeadline(
  detector: GuardDetector,
  context: Parameters<GuardDetector['detect']>[0],
): Promise<readonly Observation[]> {
  if (context.signal.aborted) throw context.signal.reason;
  return new Promise<readonly Observation[]>((resolve, reject) => {
    const onAbort = () => reject(context.signal.reason ?? new Error('deadline exceeded'));
    context.signal.addEventListener('abort', onAbort, { once: true });
    detector.detect(context).then(resolve, reject).finally(() => {
      context.signal.removeEventListener('abort', onAbort);
    });
  });
}

export function createGuardEngine(
  policy: GuardEnginePolicy,
  detectors: readonly GuardDetector[],
  dependencies: GuardEngineDependencies,
): GuardEngine {
  const now = dependencies.now ?? Date.now;
  const hmacKey = dependencies.hmacKey;
  if (Buffer.byteLength(hmacKey) < 32) {
    throw new Error('GuardEngine evidence HMAC key must contain at least 32 bytes');
  }
  const detectorIds = new Set<string>();
  for (const detector of detectors) {
    if (detectorIds.has(detector.id)) throw new Error(`Duplicate detector id: ${detector.id}`);
    detectorIds.add(detector.id);
  }

  return {
    async evaluate(request: GuardRequest) {
      const startedAt = now();
      if ((request.content.text?.length ?? 0) > 1_048_576) {
        throw new Error('GRD_TEXT_CAPACITY_EXCEEDED');
      }
      const remaining = request.context.absoluteDeadlineEpochMs - startedAt;
      if (remaining <= 0) throw new Error('GRD_DEADLINE_EXCEEDED');
      if (request.context.policyBundleId !== policy.bundleId) {
        throw new Error('GRD_POLICY_BUNDLE_MISMATCH');
      }
      const views = buildNormalizedViews(request.content.text ?? '');
      const deadlineSignal = AbortSignal.timeout(remaining);
      const evidenceHmac = (content: string) =>
        createHmac('sha256', hmacKey).update(content, 'utf8').digest('hex');
      const results = await Promise.all(detectors.map(async (detector) => {
        try {
          const observations = await runBeforeDeadline(detector, {
            request,
            views,
            signal: deadlineSignal,
            evidenceHmac,
          });
          return { detector, observations };
        } catch {
          return {
            detector,
            observations: [
              failureObservation(detector, deadlineSignal.aborted ? 'TIMEOUT' : 'ERROR'),
            ],
          };
        }
      }));
      const observations = results.flatMap((item) => item.observations);
      const requiredDetectorFailures = results
        .filter(({ detector, observations: detectorObservations }) =>
          detector.required &&
          detectorObservations.some((item) => item.status === 'ERROR' || item.status === 'TIMEOUT'),
        )
        .map(({ detector }) => `${detector.id}:unavailable`);
      const decision = aggregateGuardDecision({
        request,
        policy,
        observations,
        requiredDetectorFailures,
        latencyMs: now() - startedAt,
      });
      observeGuardDecision({
        direction: request.context.direction,
        action: decision.action,
        latencyMs: decision.latencyMs,
        detectorFailures: requiredDetectorFailures.length,
      });
      return decision;
    },
  };
}
