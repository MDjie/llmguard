import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type {
  GuardAction,
  GuardDecision,
  GuardEngine,
  GuardRequest,
} from '@/lib/guard-engine-v2';
import type {
  EnforcementAction,
  NetworkObservation,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';
import type {
  InspectionEngineAdapter,
  InspectionEngineResult,
  InspectionRequest,
} from './inspection-fabric';

const DEFAULT_MAXIMUM_TEXT_BYTES = 1024 * 1024;

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function guardAction(action: GuardAction): EnforcementAction {
  switch (action) {
    case 'ALLOW':
    case 'WARN':
      return 'ALLOW';
    case 'BLOCK':
      return 'BLOCK';
    case 'MASK':
      return 'MASK';
    case 'REWRITE':
    case 'SAFE_RESPONSE':
      return 'REWRITE';
    case 'REQUIRE_REVIEW':
      return 'QUARANTINE';
  }
}

function decodeFrameText(request: InspectionRequest, maximumTextBytes: number): string {
  const encoded = request.frame.inlinePayloadBase64;
  if (encoded === undefined || request.frame.contentReference !== undefined ||
      request.frame.sizeBytes > maximumTextBytes ||
      !/^(?:text\/|application\/(?:json|x-ndjson|xml))/u.test(request.frame.mediaType)) {
    throw new Error('GUARD_RUNTIME_FRAME_UNSUPPORTED');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== request.frame.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== request.frame.sha256) {
    throw new Error('GUARD_RUNTIME_FRAME_DIGEST_MISMATCH');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function toGuardRequest(request: InspectionRequest, text: string): GuardRequest {
  const serverToClient = request.frame.direction === 'SERVER_TO_CLIENT';
  return {
    contractVersion: '1.0',
    context: {
      traceId: request.flow.flowId,
      requestId: request.frame.frameId,
      tenantId: request.flow.tenantId,
      applicationId: request.flow.applicationId,
      direction: serverToClient ? 'OUTPUT_CHUNK' : 'INPUT',
      absoluteDeadlineEpochMs: request.frame.absoluteDeadlineEpochMs,
      policyBundleId: request.frame.policyBundleId,
      stage: serverToClient ? 'MODEL_STREAM' : 'INPUT_PRE',
    },
    content: { text },
  };
}

function mappedObservations(
  decision: GuardDecision,
  engine: Pick<ApplianceGuardRuntimeAdapter, 'engineId' | 'engineVersion' | 'ruleVersion'>,
): readonly NetworkObservation[] {
  const observations = decision.observations.map((observation): NetworkObservation => ({
    engineId: engine.engineId,
    engineType: 'AI_GUARD',
    engineVersion: engine.engineVersion,
    ruleVersion: engine.ruleVersion,
    status: observation.status,
    riskType: observation.riskType,
    severity: observation.severity,
    score: observation.score,
    ...(observation.reasonCode ? { reasonCode: observation.reasonCode } : {}),
    evidenceDigest: digest({
      detectorId: observation.detectorId,
      detectorVersion: observation.detectorVersion,
      evidence: observation.evidence,
      configurationDigest: observation.configurationDigest,
      modelVersion: observation.modelVersion,
    }),
    ...(observation.evidence[0]?.maskedPreview
      ? { maskedPreview: observation.evidence[0].maskedPreview }
      : {}),
  }));
  const summary: NetworkObservation = {
    engineId: engine.engineId,
    engineType: 'AI_GUARD',
    engineVersion: engine.engineVersion,
    ruleVersion: engine.ruleVersion,
    status: decision.action === 'ALLOW' ? 'NO_MATCH' : 'MATCH',
    riskType: 'guard_action:' + decision.action.toLowerCase(),
    severity: decision.riskLevel,
    score: decision.action === 'ALLOW' ? 0 : 1,
    reasonCode: 'GUARD_AUTHORITATIVE_DECISION',
    evidenceDigest: digest({
      decisionId: decision.decisionId,
      action: decision.action,
      policyPath: decision.policyPath,
      bundleId: decision.bundleId,
      failMode: decision.failMode,
    }),
  };
  return [...observations, summary];
}

export interface ApplianceGuardRuntimeAdapterOptions {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly ruleVersion: string;
  readonly guardEngine: GuardEngine;
  readonly maximumTextBytes?: number;
}

export class ApplianceGuardRuntimeAdapter implements InspectionEngineAdapter {
  readonly engineId: string;
  readonly engineType = 'AI_GUARD' as const;
  readonly engineVersion: string;
  readonly ruleVersion: string;
  private readonly guardEngine: GuardEngine;
  private readonly maximumTextBytes: number;

  constructor(options: ApplianceGuardRuntimeAdapterOptions) {
    const maximumTextBytes = options.maximumTextBytes ?? DEFAULT_MAXIMUM_TEXT_BYTES;
    if (options.engineId.length === 0 || options.engineVersion.length === 0 ||
        options.ruleVersion.length === 0 || !Number.isSafeInteger(maximumTextBytes) ||
        maximumTextBytes < 1) {
      throw new Error('GUARD_RUNTIME_ADAPTER_OPTIONS_INVALID');
    }
    this.engineId = options.engineId;
    this.engineVersion = options.engineVersion;
    this.ruleVersion = options.ruleVersion;
    this.guardEngine = options.guardEngine;
    this.maximumTextBytes = maximumTextBytes;
  }

  async inspect(request: InspectionRequest): Promise<InspectionEngineResult> {
    if (request.signal.aborted) throw request.signal.reason;
    const text = decodeFrameText(request, this.maximumTextBytes);
    const decision = await this.guardEngine.evaluate(toGuardRequest(request, text));
    if (decision.bundleId !== request.frame.policyBundleId ||
        decision.traceId !== request.flow.flowId ||
        decision.contractVersion !== '1.0' || decision.evidenceComplete === false ||
        decision.failMode === 'FAIL_OPEN' ||
        (decision.failMode === 'FAIL_CLOSED' && decision.action !== 'BLOCK')) {
      throw new Error('GUARD_RUNTIME_DECISION_INVALID');
    }
    const action = guardAction(decision.action);
    const transformedPayloadBase64 = ['MASK', 'REWRITE'].includes(action)
      ? decision.transformedText === undefined
        ? undefined
        : Buffer.from(decision.transformedText, 'utf8').toString('base64')
      : undefined;
    if (['MASK', 'REWRITE'].includes(action) && transformedPayloadBase64 === undefined) {
      throw new Error('GUARD_RUNTIME_TRANSFORM_MISSING');
    }
    return {
      observations: mappedObservations(decision, this),
      recommendedAction: action,
      authoritativeDecisionId: decision.decisionId,
      ...(transformedPayloadBase64 ? { transformedPayloadBase64 } : {}),
    };
  }
}
