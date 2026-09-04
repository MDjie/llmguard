import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  EnforcementDecision,
  EnforcementReceipt,
  FlowEnvelope,
  FrameEnvelope,
  NetworkBypassPermitPayloadV2,
} from '../../packages/contracts-appliance/generated/typescript/appliance-v1';
import {
  PalV2Error,
  PalV2FlowController,
  signNetworkBypassPermitV2,
  validateNetworkBypassPermitV2,
} from '../../src/lib/appliance';

const NOW = 10_000;
const PAYLOAD = Buffer.from('hello');
const PAYLOAD_SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');
const RECEIPT_SHA256 = createHash('sha256').update('receipt').digest('hex');

function flow(overrides: Partial<FlowEnvelope> = {}): FlowEnvelope {
  return {
    contractVersion: '1.0',
    deviceId: 'device-01',
    deviceGroupId: 'group-01',
    flowId: 'flow-0001',
    flowSeq: 1,
    tenantId: 'tenant-01',
    applicationId: 'app-01',
    deploymentMode: 'TRANSPARENT_INLINE',
    ingressInterface: 'port-1',
    egressInterface: 'port-2',
    source: { ip: '192.0.2.10', port: 50_000 },
    destination: { ip: '198.51.100.20', port: 80 },
    transport: 'TCP',
    applicationProtocol: 'HTTP_1_1',
    direction: 'CLIENT_TO_SERVER',
    protectedTraffic: true,
    openedAtEpochMs: 9_000,
    absoluteDeadlineEpochMs: 20_000,
    policyBundleId: 'bundle-01',
    ...overrides,
  };
}

function frame(overrides: Partial<FrameEnvelope> = {}): FrameEnvelope {
  return {
    contractVersion: '1.0',
    flowId: 'flow-0001',
    frameId: 'frame-0001',
    flowSeq: 1,
    frameSeq: 0,
    direction: 'CLIENT_TO_SERVER',
    applicationProtocol: 'HTTP_1_1',
    protocolStage: 'MESSAGE',
    mediaType: 'text/plain',
    sizeBytes: PAYLOAD.length,
    sha256: PAYLOAD_SHA256,
    streamOffsetStart: 0,
    streamOffsetEnd: PAYLOAD.length,
    absoluteDeadlineEpochMs: 15_000,
    policyBundleId: 'bundle-01',
    inlinePayloadBase64: PAYLOAD.toString('base64'),
    ...overrides,
  };
}

function decision(overrides: Partial<EnforcementDecision> = {}): EnforcementDecision {
  return {
    contractVersion: '1.0',
    decisionId: 'decision-0001',
    flowId: 'flow-0001',
    frameId: 'frame-0001',
    flowSeq: 1,
    frameSeq: 0,
    contentSha256: PAYLOAD_SHA256,
    action: 'ALLOW',
    terminal: false,
    reasonCode: 'POLICY_ALLOWED',
    policyBundleId: 'bundle-01',
    observations: [],
    issuedAtEpochMs: NOW,
    expiresAtEpochMs: 14_000,
    evidenceComplete: true,
    enforcementToken: 'valid-token-value-with-at-least-32-characters',
    ...overrides,
  };
}

function receipt(overrides: Partial<EnforcementReceipt> = {}): EnforcementReceipt {
  return {
    receiptId: 'receipt-0001',
    decisionId: 'decision-0001',
    deviceId: 'device-01',
    flowId: 'flow-0001',
    frameId: 'frame-0001',
    action: 'ALLOW',
    status: 'APPLIED',
    executedAtEpochMs: NOW + 1,
    bytesForwardedBeforeDecision: 0,
    receiptDigest: RECEIPT_SHA256,
    ...overrides,
  };
}

function controller(input = flow()): PalV2FlowController {
  return new PalV2FlowController(input, {
    now: () => NOW,
    verifyEnforcementToken: (candidate) => candidate.enforcementToken.startsWith('valid-'),
  });
}

describe('B-WP02 PAL v2 flow enforcement', () => {
  it('requires a bound decision and applied receipt before accepting another frame', () => {
    const subject = controller();
    expect(subject.open()).toMatchObject({
      action: 'INSPECT',
      reasonCode: 'PAL_FLOW_INSPECTION_REQUIRED',
    });
    subject.submitFrame(frame());
    expect(subject.snapshot()).toMatchObject({
      state: 'INSPECTING',
      pendingFrameId: 'frame-0001',
    });
    subject.applyDecision(decision());
    expect(subject.state).toBe('FORWARDING');
    subject.recordEnforcement(receipt());
    expect(subject.snapshot()).toEqual({
      flowId: 'flow-0001',
      state: 'DECODING',
      lastFrameSeq: 0,
    });
  });

  it('fails closed on mismatched or unsigned decisions', () => {
    const mismatched = controller();
    mismatched.open();
    mismatched.submitFrame(frame());
    expect(() => mismatched.applyDecision(decision({ contentSha256: 'a'.repeat(64) })))
      .toThrowError(new PalV2Error('PAL_DECISION_BINDING_MISMATCH'));
    expect(mismatched.state).toBe('BLOCKED');

    const unsigned = controller();
    unsigned.open();
    unsigned.submitFrame(frame());
    expect(() => unsigned.applyDecision(decision({ enforcementToken: 'invalid-token' })))
      .toThrowError(new PalV2Error('PAL_DECISION_TOKEN_INVALID'));
    expect(unsigned.state).toBe('BLOCKED');
  });

  it('blocks unsafe pre-commit bytes even when the decision allowed the frame', () => {
    const subject = controller();
    subject.open();
    subject.submitFrame(frame());
    subject.applyDecision(decision());
    expect(() => subject.recordEnforcement(receipt({ bytesForwardedBeforeDecision: 1 })))
      .toThrowError(new PalV2Error('PAL_UNSAFE_PRECOMMIT_BYTES'));
    expect(subject.state).toBe('BLOCKED');
  });

  it('requires TLS completion and rejects protected traffic in TAP mode', () => {
    const tls = controller(flow({
      applicationProtocol: 'HTTPS',
      destination: { ip: '198.51.100.20', port: 443 },
    }));
    expect(tls.open().action).toBe('INSPECT');
    expect(tls.state).toBe('TLS_HANDSHAKE');
    expect(() => tls.submitFrame(frame({ applicationProtocol: 'OPENAI_API' })))
      .toThrowError(new PalV2Error('PAL_STATE_INVALID'));

    const tap = controller(flow({ deploymentMode: 'TAP_MIRROR' }));
    expect(tap.open()).toMatchObject({
      action: 'BLOCK',
      reasonCode: 'PAL_TAP_CANNOT_PROTECT',
    });
  });
});

describe('B-WP02 Ed25519 network bypass permit', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload: NetworkBypassPermitPayloadV2 = {
    version: '2.0',
    permitId: 'permit-0001',
    deviceGroupId: 'group-01',
    tenantId: 'tenant-01',
    applicationId: 'app-01',
    portPairs: ['port-1:port-2'],
    protocols: ['HTTP_1_1'],
    maximumConnections: 10,
    maximumBytes: 1_000_000,
    reason: 'approved maintenance window',
    changeTicketId: 'CHG-001',
    approverIds: ['network-owner', 'security-owner'],
    policyBundleId: 'bundle-01',
    issuedAtEpochMs: 9_000,
    expiresAtEpochMs: 11_000,
  };

  function context(protectedTraffic = false) {
    return {
      deviceGroupId: 'group-01',
      tenantId: 'tenant-01',
      applicationId: 'app-01',
      portPair: 'port-1:port-2',
      protocol: 'HTTP_1_1' as const,
      policyBundleId: 'bundle-01',
      protectedTraffic,
      requestedConnections: 1,
      requestedBytes: 5,
      nowEpochMs: NOW,
    };
  }

  it('accepts only a signed, scoped, bounded and non-revoked permit', () => {
    const permit = signNetworkBypassPermitV2(payload, 'bypass-key-01', privateKey);
    const options = { keyResolver: () => publicKey };
    expect(validateNetworkBypassPermitV2(permit, context(), options)).toEqual({
      valid: true,
      reasonCode: 'NETWORK_BYPASS_VALID',
    });
    expect(validateNetworkBypassPermitV2(permit, context(true), options).reasonCode)
      .toBe('NETWORK_BYPASS_PROTECTED_TRAFFIC');
    expect(validateNetworkBypassPermitV2(permit, {
      ...context(),
      requestedConnections: 11,
    }, options).reasonCode).toBe('NETWORK_BYPASS_CAPACITY_EXCEEDED');
    expect(validateNetworkBypassPermitV2(permit, context(), {
      ...options,
      revokedPermitIds: new Set(['permit-0001']),
    }).reasonCode).toBe('NETWORK_BYPASS_REVOKED');
  });

  it('lets PAL bypass only an explicitly unprotected flow', () => {
    const permit = signNetworkBypassPermitV2(payload, 'bypass-key-01', privateKey);
    const unprotected = controller(flow({ protectedTraffic: false }));
    unprotected.open();
    expect(unprotected.failInspection(permit, {
      portPair: 'port-1:port-2',
      requestedConnections: 1,
      requestedBytes: 5,
    }, { keyResolver: () => publicKey })).toBe('NETWORK_BYPASS_VALID');
    expect(unprotected.state).toBe('BYPASSED');

    const protectedFlow = controller();
    protectedFlow.open();
    expect(protectedFlow.failInspection(permit, {
      portPair: 'port-1:port-2',
      requestedConnections: 1,
      requestedBytes: 5,
    }, { keyResolver: () => publicKey })).toBe('NETWORK_BYPASS_PROTECTED_TRAFFIC');
    expect(protectedFlow.state).toBe('BLOCKED');
  });
});
