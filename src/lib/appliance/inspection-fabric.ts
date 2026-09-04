import { createHash, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type {
  EnforcementAction,
  EnforcementDecision,
  EngineType,
  FlowEnvelope,
  FrameEnvelope,
  NetworkObservation,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';
import { signEnforcementDecision } from './enforcement-token';

export interface InspectionRequest {
  readonly flow: FlowEnvelope;
  readonly frame: FrameEnvelope;
  readonly signal: AbortSignal;
}

export interface InspectionEngineResult {
  readonly observations: readonly NetworkObservation[];
  readonly recommendedAction?: EnforcementAction;
  readonly transformedPayloadBase64?: string;
  readonly authoritativeDecisionId?: string;
}

export type InspectionEngineOutput =
  | readonly NetworkObservation[]
  | InspectionEngineResult;

export interface InspectionEngineAdapter {
  readonly engineId: string;
  readonly engineType: EngineType;
  readonly engineVersion: string;
  readonly ruleVersion: string;
  inspect(request: InspectionRequest): Promise<InspectionEngineOutput>;
}

export interface InspectionEnginePolicy {
  readonly engineId: string;
  readonly required: boolean;
  readonly timeoutMs: number;
  readonly minimumMatchScore: number;
  readonly actionOnMatch: EnforcementAction;
}

export interface InspectionFabricPolicy {
  readonly policyBundleId: string;
  readonly decisionTtlMs: number;
  readonly engines: readonly InspectionEnginePolicy[];
}

export interface InspectionFabricOptions {
  readonly signingKeyId: string;
  readonly privateKey: string | Buffer | KeyObject;
  readonly now?: () => number;
}

const ACTION_PRECEDENCE: Readonly<Record<EnforcementAction, number>> = {
  ALLOW: 0,
  MIRROR_ONLY: 1,
  REDIRECT: 2,
  RATE_LIMIT: 3,
  MASK: 4,
  REWRITE: 5,
  QUARANTINE: 6,
  RESET: 7,
  BLOCK: 8,
};
const TERMINAL_ACTIONS = new Set<EnforcementAction>(['BLOCK', 'RESET', 'QUARANTINE']);
const HASH_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/u;

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validatePolicy(
  policy: InspectionFabricPolicy,
  adapters: readonly InspectionEngineAdapter[],
): void {
  const adapterIds = adapters.map((adapter) => adapter.engineId);
  const policyIds = policy.engines.map((engine) => engine.engineId);
  if (policy.policyBundleId.length === 0 ||
      !Number.isSafeInteger(policy.decisionTtlMs) || policy.decisionTtlMs < 1 ||
      policy.engines.length === 0 || new Set(adapterIds).size !== adapterIds.length ||
      new Set(policyIds).size !== policyIds.length ||
      policyIds.some((id) => !adapterIds.includes(id)) ||
      adapterIds.some((id) => !policyIds.includes(id)) ||
      policy.engines.some((engine) => engine.engineId.length === 0 ||
        !Number.isSafeInteger(engine.timeoutMs) || engine.timeoutMs < 1 ||
        !Number.isFinite(engine.minimumMatchScore) || engine.minimumMatchScore < 0 ||
        engine.minimumMatchScore > 1 || engine.actionOnMatch === 'ALLOW' ||
        engine.actionOnMatch === 'MIRROR_ONLY')) {
    throw new Error('INSPECTION_FABRIC_POLICY_INVALID');
  }
}

function validateObservation(
  observation: NetworkObservation,
  adapter: InspectionEngineAdapter,
): boolean {
  return observation.engineId === adapter.engineId &&
    observation.engineType === adapter.engineType &&
    observation.engineVersion === adapter.engineVersion &&
    observation.ruleVersion === adapter.ruleVersion &&
    observation.riskType.length > 0 && Number.isFinite(observation.score) &&
    observation.score >= 0 && observation.score <= 1 &&
    HASH_PATTERN.test(observation.evidenceDigest);
}

function failureObservation(
  adapter: InspectionEngineAdapter,
  status: 'TIMEOUT' | 'ERROR',
): NetworkObservation {
  const reasonCode = status === 'TIMEOUT'
    ? 'INSPECTION_ENGINE_TIMEOUT'
    : 'INSPECTION_ENGINE_ERROR';
  return {
    engineId: adapter.engineId,
    engineType: adapter.engineType,
    engineVersion: adapter.engineVersion,
    ruleVersion: adapter.ruleVersion,
    status,
    riskType: 'engine_availability',
    severity: 'NONE',
    score: 0,
    reasonCode,
    evidenceDigest: sha256({ engineId: adapter.engineId, reasonCode }),
  };
}

async function inspectBeforeAbort(
  adapter: InspectionEngineAdapter,
  request: InspectionRequest,
): Promise<InspectionEngineOutput> {
  if (request.signal.aborted) throw request.signal.reason;
  return new Promise<InspectionEngineOutput>((resolve, reject) => {
    const onAbort = () => reject(request.signal.reason ?? new Error('inspection aborted'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    adapter.inspect(request).then(resolve, reject).finally(() => {
      request.signal.removeEventListener('abort', onAbort);
    });
  });
}

async function runEngine(input: {
  readonly adapter: InspectionEngineAdapter;
  readonly policy: InspectionEnginePolicy;
  readonly flow: FlowEnvelope;
  readonly frame: FrameEnvelope;
  readonly now: () => number;
}): Promise<InspectionEngineResult> {
  const remainingMs = input.frame.absoluteDeadlineEpochMs - input.now();
  if (remainingMs <= 0) {
    return { observations: [failureObservation(input.adapter, 'TIMEOUT')] };
  }
  const signal = AbortSignal.timeout(Math.min(input.policy.timeoutMs, remainingMs));
  try {
    const output = await inspectBeforeAbort(input.adapter, {
      flow: input.flow,
      frame: input.frame,
      signal,
    });
    const result: InspectionEngineResult = Array.isArray(output)
      ? { observations: output }
      : output as InspectionEngineResult;
    if (result.observations.length === 0 || result.observations.length > 1_000 ||
        result.observations.some((observation) =>
          !validateObservation(observation, input.adapter)) ||
        result.recommendedAction === 'MIRROR_ONLY' ||
        (result.recommendedAction !== undefined &&
          ['MASK', 'REWRITE'].includes(result.recommendedAction) &&
          result.transformedPayloadBase64 === undefined)) {
      return { observations: [failureObservation(input.adapter, 'ERROR')] };
    }
    return result;
  } catch {
    return {
      observations: [failureObservation(input.adapter, signal.aborted ? 'TIMEOUT' : 'ERROR')],
    };
  }
}

export class InspectionFabric {
  private readonly now: () => number;
  private readonly adaptersById: ReadonlyMap<string, InspectionEngineAdapter>;

  constructor(
    private readonly policy: InspectionFabricPolicy,
    adapters: readonly InspectionEngineAdapter[],
    private readonly options: InspectionFabricOptions,
  ) {
    validatePolicy(policy, adapters);
    if (options.signingKeyId.length === 0) throw new Error('INSPECTION_SIGNING_KEY_REQUIRED');
    this.now = options.now ?? Date.now;
    this.adaptersById = new Map(adapters.map((adapter) => [adapter.engineId, adapter]));
  }

  async inspect(flow: FlowEnvelope, frame: FrameEnvelope): Promise<EnforcementDecision> {
    const issuedAtEpochMs = this.now();
    if (flow.flowId !== frame.flowId || flow.flowSeq !== frame.flowSeq ||
        flow.policyBundleId !== this.policy.policyBundleId ||
        frame.policyBundleId !== this.policy.policyBundleId ||
        frame.absoluteDeadlineEpochMs <= issuedAtEpochMs) {
      throw new Error('INSPECTION_BINDING_OR_DEADLINE_INVALID');
    }
    const results = await Promise.all(this.policy.engines.map(async (enginePolicy) => {
      const adapter = this.adaptersById.get(enginePolicy.engineId);
      if (!adapter) throw new Error('INSPECTION_ADAPTER_UNAVAILABLE');
      const result = await runEngine({
        adapter,
        policy: enginePolicy,
        flow,
        frame,
        now: this.now,
      });
      return { enginePolicy, ...result };
    }));
    const observations = results.flatMap((result) => result.observations).sort((left, right) =>
      left.engineId.localeCompare(right.engineId) ||
      left.riskType.localeCompare(right.riskType) || right.score - left.score,
    );
    const requiredFailures = results.filter(({ enginePolicy, observations: values }) =>
      enginePolicy.required && values.some((value) =>
        value.status === 'ERROR' || value.status === 'TIMEOUT' || value.status === 'SKIPPED',
      ),
    );
    let action: EnforcementAction = requiredFailures.length > 0 ? 'BLOCK' : 'ALLOW';
    let selectedResult: (typeof results)[number] | undefined;
    for (const result of results) {
      const matched = result.observations.some((observation) =>
        observation.status === 'MATCH' &&
        observation.score >= result.enginePolicy.minimumMatchScore,
      );
      const candidate = result.recommendedAction ?? result.enginePolicy.actionOnMatch;
      if (matched && ACTION_PRECEDENCE[candidate] > ACTION_PRECEDENCE[action]) {
        action = candidate;
        selectedResult = result;
      }
    }
    const reasonCode = requiredFailures.length > 0
      ? 'REQUIRED_INSPECTION_ENGINE_FAILED'
      : action === 'ALLOW'
        ? 'ALL_INSPECTION_ENGINES_CLEAN'
        : 'INSPECTION_POLICY_MATCH';
    const decisionSeed = {
      flowId: flow.flowId,
      frameId: frame.frameId,
      flowSeq: flow.flowSeq,
      frameSeq: frame.frameSeq,
      contentSha256: frame.sha256,
      policyBundleId: this.policy.policyBundleId,
      action,
      reasonCode,
      observations,
    };
    const expiresAtEpochMs = Math.min(
      frame.absoluteDeadlineEpochMs,
      issuedAtEpochMs + this.policy.decisionTtlMs,
    );
    const unsigned = {
      contractVersion: '1.0' as const,
      decisionId: 'apd_' + sha256(decisionSeed).slice(0, 32),
      flowId: flow.flowId,
      frameId: frame.frameId,
      flowSeq: flow.flowSeq,
      frameSeq: frame.frameSeq,
      contentSha256: frame.sha256,
      action,
      terminal: TERMINAL_ACTIONS.has(action),
      reasonCode,
      policyBundleId: this.policy.policyBundleId,
      observations,
      issuedAtEpochMs,
      expiresAtEpochMs,
      evidenceComplete: observations.every((observation) =>
        HASH_PATTERN.test(observation.evidenceDigest)),
      ...(selectedResult?.authoritativeDecisionId
        ? { guardDecisionId: selectedResult.authoritativeDecisionId }
        : {}),
      ...(selectedResult?.transformedPayloadBase64 && ['MASK', 'REWRITE'].includes(action)
        ? { transformedPayloadBase64: selectedResult.transformedPayloadBase64 }
        : {}),
    };
    return signEnforcementDecision(unsigned, this.options);
  }
}
