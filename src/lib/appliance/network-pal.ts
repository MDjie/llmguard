import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle';

export type ApplianceProtocol =
  | 'HTTP_1_1'
  | 'HTTP_2'
  | 'HTTPS'
  | 'SSE'
  | 'WEBSOCKET'
  | 'GRPC'
  | 'OPENAI_API'
  | 'MQTT'
  | 'MCP';

export type NetworkFlowState =
  | 'NEW'
  | 'TLS_HANDSHAKE'
  | 'DECODING'
  | 'INSPECTING'
  | 'FORWARDING'
  | 'BLOCKED'
  | 'BYPASSED'
  | 'TERMINATED';

export type NetworkFlowEvent =
  | 'START_TLS'
  | 'START_CLEAR_TEXT'
  | 'TLS_ESTABLISHED'
  | 'FRAME_COMPLETE'
  | 'INSPECTION_ALLOW'
  | 'INSPECTION_BLOCK'
  | 'INSPECTION_FAILURE'
  | 'CLOSE';

export interface NetworkBypassPermitPayload {
  readonly version: 1;
  readonly permitId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly protocols: readonly ApplianceProtocol[];
  readonly reason: string;
  readonly approverIds: readonly string[];
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface SignedNetworkBypassPermit {
  readonly keyId: string;
  readonly algorithm: 'HMAC-SHA256';
  readonly payload: NetworkBypassPermitPayload;
  readonly signature: string;
}

export interface NetworkFlowContext {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly protocol: ApplianceProtocol;
  readonly protectedTraffic: boolean;
  readonly nowEpochMs: number;
  readonly bypassPermit?: SignedNetworkBypassPermit;
}

export interface NetworkFlowTransition {
  readonly state: NetworkFlowState;
  readonly reasonCode: string;
}

function permitSignature(payload: NetworkBypassPermitPayload, key: string | Buffer): Buffer {
  return createHmac('sha256', key).update(canonicalJson(payload)).digest();
}

export function signNetworkBypassPermit(
  payload: NetworkBypassPermitPayload,
  keyId: string,
  key: string | Buffer,
): SignedNetworkBypassPermit {
  if (!payload.permitId || !payload.reason || new Set(payload.approverIds).size < 2 ||
      payload.protocols.length === 0 || payload.expiresAtEpochMs <= payload.issuedAtEpochMs) {
    throw new Error('NETWORK_BYPASS_PERMIT_INVALID');
  }
  return {
    keyId,
    algorithm: 'HMAC-SHA256',
    payload,
    signature: permitSignature(payload, key).toString('base64url'),
  };
}

export function validNetworkBypassPermit(
  permit: SignedNetworkBypassPermit | undefined,
  context: Omit<NetworkFlowContext, 'bypassPermit' | 'protectedTraffic'>,
  keyResolver: (keyId: string) => string | Buffer | undefined,
): boolean {
  if (!permit || permit.algorithm !== 'HMAC-SHA256') return false;
  const key = keyResolver(permit.keyId);
  if (!key || permit.payload.tenantId !== context.tenantId ||
      permit.payload.applicationId !== context.applicationId ||
      !permit.payload.protocols.includes(context.protocol) ||
      permit.payload.issuedAtEpochMs > context.nowEpochMs ||
      permit.payload.expiresAtEpochMs <= context.nowEpochMs ||
      new Set(permit.payload.approverIds).size < 2) return false;
  const actual = Buffer.from(permit.signature, 'base64url');
  const expected = permitSignature(permit.payload, key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function transitionNetworkFlow(
  state: NetworkFlowState,
  event: NetworkFlowEvent,
  context: NetworkFlowContext,
  keyResolver: (keyId: string) => string | Buffer | undefined,
): NetworkFlowTransition {
  if (event === 'CLOSE') return { state: 'TERMINATED', reasonCode: 'NETWORK_FLOW_CLOSED' };
  if (event === 'INSPECTION_FAILURE') {
    const bypassAllowed = !context.protectedTraffic && validNetworkBypassPermit(
      context.bypassPermit,
      context,
      keyResolver,
    );
    return bypassAllowed
      ? { state: 'BYPASSED', reasonCode: 'NETWORK_SIGNED_BYPASS_APPLIED' }
      : { state: 'BLOCKED', reasonCode: 'NETWORK_INSPECTION_FAILED_CLOSED' };
  }
  const transitions: Partial<Record<NetworkFlowState, Partial<Record<NetworkFlowEvent, NetworkFlowTransition>>>> = {
    NEW: {
      START_TLS: { state: 'TLS_HANDSHAKE', reasonCode: 'NETWORK_TLS_STARTED' },
      START_CLEAR_TEXT: { state: 'DECODING', reasonCode: 'NETWORK_DECODING_STARTED' },
    },
    TLS_HANDSHAKE: {
      TLS_ESTABLISHED: { state: 'DECODING', reasonCode: 'NETWORK_TLS_VERIFIED' },
    },
    DECODING: {
      FRAME_COMPLETE: { state: 'INSPECTING', reasonCode: 'NETWORK_FRAME_BOUND' },
    },
    INSPECTING: {
      INSPECTION_ALLOW: { state: 'FORWARDING', reasonCode: 'NETWORK_INSPECTION_ALLOWED' },
      INSPECTION_BLOCK: { state: 'BLOCKED', reasonCode: 'NETWORK_INSPECTION_BLOCKED' },
    },
  };
  const next = transitions[state]?.[event];
  if (!next) return { state: 'BLOCKED', reasonCode: 'NETWORK_PROTOCOL_TRANSITION_INVALID' };
  return next;
}
