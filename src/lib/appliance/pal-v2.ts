import type {
  EnforcementDecision,
  EnforcementReceipt,
  FlowAdmission,
  FlowEnvelope,
  FrameEnvelope,
  SignedNetworkBypassPermitV2,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';
import {
  validateNetworkBypassPermitV2,
  type NetworkBypassValidationOptionsV2,
} from './bypass-permit-v2';

export type PalV2FlowState =
  | 'NEW'
  | 'TLS_HANDSHAKE'
  | 'DECODING'
  | 'INSPECTING'
  | 'FORWARDING'
  | 'BLOCKED'
  | 'BYPASSED'
  | 'TERMINATED';

export type PalV2ErrorCode =
  | 'PAL_FLOW_INVALID'
  | 'PAL_FLOW_EXPIRED'
  | 'PAL_TAP_CANNOT_PROTECT'
  | 'PAL_STATE_INVALID'
  | 'PAL_TLS_STATE_INVALID'
  | 'PAL_FRAME_INVALID'
  | 'PAL_FRAME_BINDING_MISMATCH'
  | 'PAL_FRAME_SEQUENCE_INVALID'
  | 'PAL_FRAME_DEADLINE_INVALID'
  | 'PAL_FRAME_PAYLOAD_INVALID'
  | 'PAL_DECISION_BINDING_MISMATCH'
  | 'PAL_DECISION_EXPIRED'
  | 'PAL_DECISION_TOKEN_INVALID'
  | 'PAL_DECISION_EVIDENCE_INCOMPLETE'
  | 'PAL_DECISION_ACTION_INVALID'
  | 'PAL_RECEIPT_BINDING_MISMATCH'
  | 'PAL_UNSAFE_PRECOMMIT_BYTES'
  | 'PAL_RECEIPT_NOT_APPLIED';

export class PalV2Error extends Error {
  readonly code: PalV2ErrorCode;

  constructor(code: PalV2ErrorCode) {
    super(code);
    this.name = 'PalV2Error';
    this.code = code;
  }
}

export interface PalV2ControllerOptions {
  readonly now?: () => number;
  readonly maximumInlineFrameBytes?: number;
  readonly verifyEnforcementToken: (decision: EnforcementDecision) => boolean;
}

export interface PalV2Snapshot {
  readonly flowId: string;
  readonly state: PalV2FlowState;
  readonly lastFrameSeq: number;
  readonly pendingFrameId?: string;
  readonly pendingDecisionId?: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_MAXIMUM_INLINE_FRAME_BYTES = 4 * 1024 * 1024;
const BLOCKING_ACTIONS = new Set(['BLOCK', 'RESET', 'QUARANTINE']);
const TRANSFORM_ACTIONS = new Set(['MASK', 'REWRITE']);

function ensureFlowValid(flow: FlowEnvelope): void {
  const endpoints = [flow.source, flow.destination];
  if (flow.contractVersion !== '1.0' || flow.deviceId.length === 0 ||
      flow.deviceGroupId.length === 0 || flow.flowId.length < 8 ||
      !Number.isSafeInteger(flow.flowSeq) || flow.flowSeq < 0 ||
      flow.tenantId.length === 0 || flow.applicationId.length === 0 ||
      flow.ingressInterface.length === 0 || flow.egressInterface.length === 0 ||
      flow.policyBundleId.length === 0 ||
      endpoints.some((endpoint) => endpoint.ip.length < 2 ||
        !Number.isSafeInteger(endpoint.port) || endpoint.port < 0 || endpoint.port > 65535) ||
      !Number.isSafeInteger(flow.openedAtEpochMs) || flow.openedAtEpochMs <= 0 ||
      !Number.isSafeInteger(flow.absoluteDeadlineEpochMs) ||
      flow.absoluteDeadlineEpochMs <= flow.openedAtEpochMs) {
    throw new PalV2Error('PAL_FLOW_INVALID');
  }
}

function isTlsProtocol(flow: FlowEnvelope): boolean {
  return flow.applicationProtocol === 'TLS' || flow.applicationProtocol === 'HTTPS';
}

function decodedInlineLength(payload: string): number | undefined {
  if (payload.length === 0 || payload.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) return undefined;
  try {
    return Buffer.from(payload, 'base64').length;
  } catch {
    return undefined;
  }
}

export class PalV2FlowController {
  readonly flow: FlowEnvelope;
  private readonly now: () => number;
  private readonly maximumInlineFrameBytes: number;
  private readonly verifyEnforcementToken: (decision: EnforcementDecision) => boolean;
  private currentState: PalV2FlowState = 'NEW';
  private lastFrameSeq = -1;
  private lastStreamOffsetEnd = 0;
  private pendingFrame: FrameEnvelope | undefined;
  private pendingDecision: EnforcementDecision | undefined;

  constructor(flow: FlowEnvelope, options: PalV2ControllerOptions) {
    ensureFlowValid(flow);
    const maximumInlineFrameBytes = options.maximumInlineFrameBytes ??
      DEFAULT_MAXIMUM_INLINE_FRAME_BYTES;
    if (!Number.isSafeInteger(maximumInlineFrameBytes) || maximumInlineFrameBytes <= 0) {
      throw new PalV2Error('PAL_FLOW_INVALID');
    }
    this.flow = flow;
    this.now = options.now ?? Date.now;
    this.maximumInlineFrameBytes = maximumInlineFrameBytes;
    this.verifyEnforcementToken = options.verifyEnforcementToken;
  }

  get state(): PalV2FlowState {
    return this.currentState;
  }

  open(): FlowAdmission {
    if (this.currentState !== 'NEW') throw new PalV2Error('PAL_STATE_INVALID');
    const now = this.now();
    if (this.flow.absoluteDeadlineEpochMs <= now) {
      this.currentState = 'BLOCKED';
      return this.admission('BLOCK', 'PAL_FLOW_EXPIRED', now);
    }
    if (this.flow.deploymentMode === 'TAP_MIRROR') {
      if (this.flow.protectedTraffic) {
        this.currentState = 'BLOCKED';
        return this.admission('BLOCK', 'PAL_TAP_CANNOT_PROTECT', now);
      }
      this.currentState = 'DECODING';
      return this.admission('MIRROR_ONLY', 'PAL_TAP_MIRROR_ADMITTED', now);
    }
    this.currentState = isTlsProtocol(this.flow) ? 'TLS_HANDSHAKE' : 'DECODING';
    return this.admission('INSPECT', 'PAL_FLOW_INSPECTION_REQUIRED', now);
  }

  markTlsEstablished(): void {
    if (this.currentState !== 'TLS_HANDSHAKE') {
      this.blockAndThrow('PAL_TLS_STATE_INVALID');
    }
    this.currentState = 'DECODING';
  }

  submitFrame(frame: FrameEnvelope): void {
    if (this.currentState !== 'DECODING') throw new PalV2Error('PAL_STATE_INVALID');
    if (frame.contractVersion !== '1.0' || frame.frameId.length < 8 ||
        !Number.isSafeInteger(frame.frameSeq) || frame.frameSeq < 0 ||
        !Number.isSafeInteger(frame.flowSeq) || frame.flowSeq < 0 ||
        !Number.isSafeInteger(frame.sizeBytes) || frame.sizeBytes < 0 ||
        !Number.isSafeInteger(frame.streamOffsetStart) || frame.streamOffsetStart < 0 ||
        !Number.isSafeInteger(frame.streamOffsetEnd) ||
        frame.streamOffsetEnd < frame.streamOffsetStart ||
        !SHA256_PATTERN.test(frame.sha256)) {
      this.blockAndThrow('PAL_FRAME_INVALID');
    }
    if (frame.flowId !== this.flow.flowId || frame.flowSeq !== this.flow.flowSeq ||
        frame.policyBundleId !== this.flow.policyBundleId) {
      this.blockAndThrow('PAL_FRAME_BINDING_MISMATCH');
    }
    if (frame.frameSeq <= this.lastFrameSeq ||
        frame.streamOffsetStart < this.lastStreamOffsetEnd) {
      this.blockAndThrow('PAL_FRAME_SEQUENCE_INVALID');
    }
    if (!Number.isSafeInteger(frame.absoluteDeadlineEpochMs) ||
        frame.absoluteDeadlineEpochMs <= this.now() ||
        frame.absoluteDeadlineEpochMs > this.flow.absoluteDeadlineEpochMs) {
      this.blockAndThrow('PAL_FRAME_DEADLINE_INVALID');
    }
    const hasInlinePayload = frame.inlinePayloadBase64 !== undefined;
    const hasReference = frame.contentReference !== undefined;
    if (hasInlinePayload === hasReference) this.blockAndThrow('PAL_FRAME_PAYLOAD_INVALID');
    if (frame.inlinePayloadBase64 !== undefined) {
      const decodedLength = decodedInlineLength(frame.inlinePayloadBase64);
      if (decodedLength === undefined || decodedLength !== frame.sizeBytes ||
          decodedLength > this.maximumInlineFrameBytes) {
        this.blockAndThrow('PAL_FRAME_PAYLOAD_INVALID');
      }
    }
    if (frame.contentReference &&
        (frame.contentReference.sha256 !== frame.sha256 ||
          frame.contentReference.expiresAtEpochMs < frame.absoluteDeadlineEpochMs)) {
      this.blockAndThrow('PAL_FRAME_PAYLOAD_INVALID');
    }
    this.pendingFrame = frame;
    this.pendingDecision = undefined;
    this.lastFrameSeq = frame.frameSeq;
    this.lastStreamOffsetEnd = frame.streamOffsetEnd;
    this.currentState = 'INSPECTING';
  }

  applyDecision(decision: EnforcementDecision): void {
    const frame = this.pendingFrame;
    if (this.currentState !== 'INSPECTING' || !frame) {
      throw new PalV2Error('PAL_STATE_INVALID');
    }
    if (decision.contractVersion !== '1.0' || decision.flowId !== this.flow.flowId ||
        decision.frameId !== frame.frameId || decision.flowSeq !== this.flow.flowSeq ||
        decision.frameSeq !== frame.frameSeq || decision.contentSha256 !== frame.sha256 ||
        decision.policyBundleId !== this.flow.policyBundleId) {
      this.blockAndThrow('PAL_DECISION_BINDING_MISMATCH');
    }
    const now = this.now();
    if (!Number.isSafeInteger(decision.issuedAtEpochMs) ||
        !Number.isSafeInteger(decision.expiresAtEpochMs) ||
        decision.issuedAtEpochMs > now || decision.expiresAtEpochMs <= now ||
        decision.expiresAtEpochMs > frame.absoluteDeadlineEpochMs) {
      this.blockAndThrow('PAL_DECISION_EXPIRED');
    }
    if (!this.verifyEnforcementToken(decision)) {
      this.blockAndThrow('PAL_DECISION_TOKEN_INVALID');
    }
    if (this.flow.protectedTraffic && decision.action === 'ALLOW' &&
        !decision.evidenceComplete) {
      this.blockAndThrow('PAL_DECISION_EVIDENCE_INCOMPLETE');
    }
    if (decision.action === 'MIRROR_ONLY' && this.flow.deploymentMode !== 'TAP_MIRROR') {
      this.blockAndThrow('PAL_DECISION_ACTION_INVALID');
    }
    if (TRANSFORM_ACTIONS.has(decision.action) &&
        decision.transformedPayloadBase64 === undefined) {
      this.blockAndThrow('PAL_DECISION_ACTION_INVALID');
    }
    if (BLOCKING_ACTIONS.has(decision.action) && !decision.terminal) {
      this.blockAndThrow('PAL_DECISION_ACTION_INVALID');
    }
    this.pendingDecision = decision;
    this.currentState = BLOCKING_ACTIONS.has(decision.action) ? 'BLOCKED' : 'FORWARDING';
  }

  recordEnforcement(receipt: EnforcementReceipt): void {
    const decision = this.pendingDecision;
    const frame = this.pendingFrame;
    if (!decision || !frame ||
        (this.currentState !== 'FORWARDING' && this.currentState !== 'BLOCKED')) {
      throw new PalV2Error('PAL_STATE_INVALID');
    }
    if (receipt.decisionId !== decision.decisionId ||
        receipt.deviceId !== this.flow.deviceId ||
        receipt.flowId !== this.flow.flowId || receipt.frameId !== frame.frameId ||
        receipt.action !== decision.action || !SHA256_PATTERN.test(receipt.receiptDigest)) {
      this.blockAndThrow('PAL_RECEIPT_BINDING_MISMATCH');
    }
    if (receipt.bytesForwardedBeforeDecision !== 0) {
      this.blockAndThrow('PAL_UNSAFE_PRECOMMIT_BYTES');
    }
    if (receipt.status !== 'APPLIED') {
      this.blockAndThrow('PAL_RECEIPT_NOT_APPLIED');
    }
    const blocked = BLOCKING_ACTIONS.has(decision.action);
    this.pendingFrame = undefined;
    this.pendingDecision = undefined;
    this.currentState = blocked ? 'TERMINATED' : 'DECODING';
  }

  failInspection(
    permit: SignedNetworkBypassPermitV2 | undefined,
    input: {
      readonly portPair: string;
      readonly requestedConnections: number;
      readonly requestedBytes: number;
    },
    options: NetworkBypassValidationOptionsV2,
  ): string {
    if (!['TLS_HANDSHAKE', 'DECODING', 'INSPECTING'].includes(this.currentState)) {
      throw new PalV2Error('PAL_STATE_INVALID');
    }
    const validation = validateNetworkBypassPermitV2(permit, {
      deviceGroupId: this.flow.deviceGroupId,
      tenantId: this.flow.tenantId,
      applicationId: this.flow.applicationId,
      portPair: input.portPair,
      protocol: this.flow.applicationProtocol,
      policyBundleId: this.flow.policyBundleId,
      protectedTraffic: this.flow.protectedTraffic,
      requestedConnections: input.requestedConnections,
      requestedBytes: input.requestedBytes,
      nowEpochMs: this.now(),
    }, options);
    this.pendingFrame = undefined;
    this.pendingDecision = undefined;
    this.currentState = validation.valid ? 'BYPASSED' : 'BLOCKED';
    return validation.reasonCode;
  }

  close(): void {
    this.pendingFrame = undefined;
    this.pendingDecision = undefined;
    this.currentState = 'TERMINATED';
  }

  snapshot(): PalV2Snapshot {
    return {
      flowId: this.flow.flowId,
      state: this.currentState,
      lastFrameSeq: this.lastFrameSeq,
      ...(this.pendingFrame ? { pendingFrameId: this.pendingFrame.frameId } : {}),
      ...(this.pendingDecision ? { pendingDecisionId: this.pendingDecision.decisionId } : {}),
    };
  }

  private admission(
    action: FlowAdmission['action'],
    reasonCode: string,
    now: number,
  ): FlowAdmission {
    return {
      flowId: this.flow.flowId,
      flowSeq: this.flow.flowSeq,
      action,
      reasonCode,
      policyBundleId: this.flow.policyBundleId,
      expiresAtEpochMs: Math.min(this.flow.absoluteDeadlineEpochMs, now + 60_000),
    };
  }

  private blockAndThrow(code: PalV2ErrorCode): never {
    this.currentState = 'BLOCKED';
    throw new PalV2Error(code);
  }
}
