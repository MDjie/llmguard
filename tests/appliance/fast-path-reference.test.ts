import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  EnforcementDecision,
  EnforcementReceipt,
  FlowEnvelope,
} from '../../packages/contracts-appliance/generated/typescript/appliance-v1';
import { FastPathReferenceModel, type FastPathPolicy } from '@/lib/appliance/fast-path-reference';

const NOW = 10_000;
const policy: FastPathPolicy = {
  policyBundleId: 'bundle-1',
  ingressToEgress: { p1: 'p2', p2: 'p1' },
  maximumActiveConnections: 2,
  maximumConnectionsPerSource: 1,
  admissionTtlMs: 500,
  reinjectionTtlMs: 100,
  aclRules: [
    { ruleId: 'deny-admin', priority: 1, action: 'DENY', destinationPorts: [22] },
    { ruleId: 'inspect-ai', priority: 2, action: 'DEEP_INSPECT', destinationPorts: [443] },
    { ruleId: 'metadata-dns', priority: 3, action: 'ALLOW_METADATA_ONLY', destinationPorts: [53] },
  ],
};

function flow(overrides: Partial<FlowEnvelope> = {}): FlowEnvelope {
  return {
    contractVersion: '1.0', deviceId: 'device-1', deviceGroupId: 'group-1',
    flowId: 'flow-0001', flowSeq: 1, tenantId: 'tenant-1', applicationId: 'app-1',
    deploymentMode: 'TRANSPARENT_INLINE', ingressInterface: 'p1', egressInterface: 'p2',
    source: { ip: '192.0.2.1', port: 50_000 }, destination: { ip: '198.51.100.1', port: 443 },
    transport: 'TCP', applicationProtocol: 'HTTPS', direction: 'CLIENT_TO_SERVER',
    protectedTraffic: true, openedAtEpochMs: 9_000, absoluteDeadlineEpochMs: 20_000,
    policyBundleId: 'bundle-1', ...overrides,
  };
}

function decision(overrides: Partial<EnforcementDecision> = {}): EnforcementDecision {
  return {
    contractVersion: '1.0', decisionId: 'decision-1', flowId: 'flow-0001',
    frameId: 'frame-0001', flowSeq: 1, frameSeq: 0, contentSha256: 'a'.repeat(64),
    action: 'ALLOW', terminal: false, reasonCode: 'CLEAN', policyBundleId: 'bundle-1',
    observations: [], issuedAtEpochMs: NOW, expiresAtEpochMs: 11_000,
    evidenceComplete: true, enforcementToken: 'valid-token', ...overrides,
  };
}

function receipt(overrides: Partial<EnforcementReceipt> = {}): EnforcementReceipt {
  return {
    receiptId: 'receipt-1', decisionId: 'decision-1', deviceId: 'device-1',
    flowId: 'flow-0001', frameId: 'frame-0001', action: 'ALLOW', status: 'APPLIED',
    executedAtEpochMs: NOW + 1, bytesForwardedBeforeDecision: 0,
    receiptDigest: createHash('sha256').update('receipt').digest('hex'), ...overrides,
  };
}

function subject() {
  return new FastPathReferenceModel(policy, (value) => value.enforcementToken === 'valid-token', {
    now: () => NOW,
  });
}

describe('FastPath conformance reference', () => {
  it('applies deterministic ACL and never metadata-allows protected traffic', () => {
    expect(subject().admitFlow(flow({ destination: { ip: '198.51.100.1', port: 22 } })))
      .toMatchObject({ action: 'BLOCK', reasonCode: 'FAST_PATH_ACL_DENY:deny-admin' });
    expect(subject().admitFlow(flow({
      destination: { ip: '198.51.100.1', port: 53 }, protectedTraffic: true,
    })).action).toBe('INSPECT');
    expect(subject().admitFlow(flow({
      destination: { ip: '198.51.100.1', port: 53 }, protectedTraffic: false,
    })).action).toBe('ALLOW_METADATA_ONLY');
  });

  it('counts metadata-only connections against the same source capacity', () => {
    const model = subject();
    expect(model.admitFlow(flow({
      destination: { ip: '198.51.100.1', port: 53 }, protectedTraffic: false,
    })).action).toBe('ALLOW_METADATA_ONLY');
    expect(model.snapshot()).toMatchObject({
      activeConnections: 1,
      sourceConnections: { '192.0.2.1': 1 },
      states: { 'flow-0001': 'FORWARDING' },
    });
    expect(model.admitFlow(flow({ flowId: 'flow-0002', flowSeq: 2 }))).toMatchObject({
      action: 'BLOCK', reasonCode: 'FAST_PATH_CONNECTION_LIMIT_EXCEEDED',
    });
  });

  it('requires a verified, bound decision before reinjection', () => {
    const model = subject();
    expect(model.admitFlow(flow()).action).toBe('INSPECT');
    expect(() => model.authorizeReinjection('flow-0001'))
      .toThrow('FAST_PATH_REINJECTION_NOT_AUTHORIZED');
    model.applyDecision(decision());
    expect(model.authorizeReinjection('flow-0001')).toMatchObject({
      decisionId: 'decision-1', egressInterface: 'p2', action: 'ALLOW',
    });
    model.recordEnforcement(receipt());
    expect(model.snapshot().states).toEqual({ 'flow-0001': 'FORWARDING' });
  });

  it('fails closed on unsigned decisions and unsafe precommit receipts', () => {
    const unsigned = subject();
    unsigned.admitFlow(flow());
    expect(() => unsigned.applyDecision(decision({ enforcementToken: 'bad' })))
      .toThrow('FAST_PATH_DECISION_INVALID');

    const unsafe = subject();
    unsafe.admitFlow(flow());
    unsafe.applyDecision(decision());
    expect(() => unsafe.recordEnforcement(receipt({ bytesForwardedBeforeDecision: 1 })))
      .toThrow('FAST_PATH_ENFORCEMENT_RECEIPT_INVALID');
    expect(unsafe.snapshot().states).toEqual({ 'flow-0001': 'BLOCKED' });

    const incomplete = subject();
    incomplete.admitFlow(flow());
    expect(() => incomplete.applyDecision(decision({ evidenceComplete: false })))
      .toThrow('FAST_PATH_DECISION_INVALID');

    const nonTerminal = subject();
    nonTerminal.admitFlow(flow());
    expect(() => nonTerminal.applyDecision(decision({ action: 'BLOCK', terminal: false })))
      .toThrow('FAST_PATH_DECISION_INVALID');
  });

  it('enforces per-source connection capacity and releases it on close', () => {
    const model = subject();
    model.admitFlow(flow());
    expect(model.admitFlow(flow({ flowId: 'flow-0002', flowSeq: 2 }))).toMatchObject({
      action: 'BLOCK', reasonCode: 'FAST_PATH_CONNECTION_LIMIT_EXCEEDED',
    });
    model.closeFlow('flow-0001');
    expect(model.admitFlow(flow({ flowId: 'flow-0002', flowSeq: 2 })).action).toBe('INSPECT');
  });

  it('rejects wrong bundle/port bindings and does not restore old authorization after restart', () => {
    expect(subject().admitFlow(flow({ policyBundleId: 'stale' })).action).toBe('BLOCK');
    expect(subject().admitFlow(flow({ egressInterface: 'p3' })).action).toBe('BLOCK');
    const restarted = subject();
    expect(() => restarted.applyDecision(decision())).toThrow('FAST_PATH_DECISION_INVALID');
  });

  it('never claims inline enforcement in TAP mode', () => {
    expect(subject().admitFlow(flow({
      deploymentMode: 'TAP_MIRROR', protectedTraffic: false,
    })).action).toBe('MIRROR_ONLY');
    expect(subject().admitFlow(flow({
      deploymentMode: 'TAP_MIRROR', protectedTraffic: true,
    })).action).toBe('BLOCK');
  });
});
