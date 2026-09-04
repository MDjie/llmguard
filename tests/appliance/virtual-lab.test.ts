import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  EnforcementDecision,
  FlowEnvelope,
  FrameEnvelope,
  NetworkObservation,
} from '../../packages/contracts-appliance/generated/typescript/appliance-v1';
import {
  InspectionFabric,
  verifyEnforcementDecisionToken,
  type InspectionEngineAdapter,
} from '@/lib/appliance';
import { EvidenceWal, verifyEvidenceRecords } from '@/lib/appliance/evidence-wal';
import { FastPathReferenceModel } from '@/lib/appliance/fast-path-reference';
import { VirtualApplianceLab } from '@/lib/appliance/virtual-lab';

const NOW = 10_000;
const decisionKeys = generateKeyPairSync('ed25519');
const evidenceKeys = generateKeyPairSync('ed25519');

function contentSha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function flow(overrides: Partial<FlowEnvelope> = {}): FlowEnvelope {
  return {
    contractVersion: '1.0', deviceId: 'device-1', deviceGroupId: 'group-1',
    flowId: 'flow-0001', flowSeq: 1, tenantId: 'tenant-1', applicationId: 'app-1',
    deploymentMode: 'TRANSPARENT_INLINE', ingressInterface: 'p1', egressInterface: 'p2',
    source: { ip: '192.0.2.1', port: 50_000 },
    destination: { ip: '198.51.100.1', port: 443 }, transport: 'TCP',
    applicationProtocol: 'HTTP_1_1', direction: 'CLIENT_TO_SERVER', protectedTraffic: true,
    openedAtEpochMs: 9_000, absoluteDeadlineEpochMs: 20_000,
    policyBundleId: 'bundle-1', ...overrides,
  };
}

function frame(input: {
  readonly sequence?: number;
  readonly offset?: number;
  readonly value?: string;
  readonly applicationProtocol?: FrameEnvelope['applicationProtocol'];
} = {}): FrameEnvelope {
  const sequence = input.sequence ?? 0;
  const offset = input.offset ?? 0;
  const content = Buffer.from(input.value ?? 'inspect me');
  return {
    contractVersion: '1.0', flowId: 'flow-0001', frameId: `frame-000${sequence + 1}`,
    flowSeq: 1, frameSeq: sequence, direction: 'CLIENT_TO_SERVER',
    applicationProtocol: input.applicationProtocol ?? 'HTTP_1_1', protocolStage: 'MESSAGE',
    mediaType: 'text/plain', sizeBytes: content.length, sha256: contentSha256(content),
    streamOffsetStart: offset, streamOffsetEnd: offset + content.length,
    absoluteDeadlineEpochMs: 15_000, policyBundleId: 'bundle-1',
    inlinePayloadBase64: content.toString('base64'),
  };
}

function observation(
  engineId: string,
  status: NetworkObservation['status'],
): NetworkObservation {
  return {
    engineId, engineType: 'IPS', engineVersion: '1.0.0', ruleVersion: 'rules-1',
    status, riskType: status === 'MATCH' ? 'attack' : 'none',
    severity: status === 'MATCH' ? 'HIGH' : 'NONE', score: status === 'MATCH' ? 1 : 0,
    evidenceDigest: contentSha256(Buffer.from(engineId + status)),
  };
}

function adapter(
  inspect: InspectionEngineAdapter['inspect'],
): InspectionEngineAdapter {
  return {
    engineId: 'ips', engineType: 'IPS', engineVersion: '1.0.0', ruleVersion: 'rules-1',
    inspect,
  };
}

function subject(input: {
  readonly inspect?: InspectionEngineAdapter['inspect'];
  readonly maximumEvidenceRecords?: number;
} = {}) {
  const verifyDecision = (candidate: EnforcementDecision) =>
    verifyEnforcementDecisionToken(candidate, (keyId) =>
      keyId === 'decision-key-1' ? decisionKeys.publicKey : undefined);
  const fastPath = new FastPathReferenceModel({
    policyBundleId: 'bundle-1', ingressToEgress: { p1: 'p2', p2: 'p1' },
    maximumActiveConnections: 10, maximumConnectionsPerSource: 5,
    admissionTtlMs: 1_000, reinjectionTtlMs: 500,
    aclRules: [{
      ruleId: 'inspect-ai', priority: 1, action: 'DEEP_INSPECT', destinationPorts: [443],
    }],
  }, verifyDecision, { now: () => NOW });
  const fabric = new InspectionFabric({
    policyBundleId: 'bundle-1', decisionTtlMs: 1_000,
    engines: [{
      engineId: 'ips', required: true, timeoutMs: 50, minimumMatchScore: 0.7,
      actionOnMatch: 'BLOCK',
    }],
  }, [adapter(input.inspect ?? (async () => [observation('ips', 'NO_MATCH')]))], {
    signingKeyId: 'decision-key-1', privateKey: decisionKeys.privateKey, now: () => NOW,
  });
  const evidenceWal = new EvidenceWal({
    deviceId: 'device-1', signingKeyId: 'evidence-key-1', privateKey: evidenceKeys.privateKey,
    maximumRecords: input.maximumEvidenceRecords ?? 20, highWatermarkRatio: 0.8,
  });
  return {
    evidenceWal,
    lab: new VirtualApplianceLab(fastPath, fabric, evidenceWal, {
      verifyEnforcementToken: verifyDecision, now: () => NOW,
    }),
  };
}

describe('B-WP03 virtual appliance lab', () => {
  it('releases clean content only after a bound decision and zero-precommit receipt', async () => {
    const { lab, evidenceWal } = subject();
    expect(lab.openFlow(flow())).toMatchObject({ admission: { action: 'INSPECT' } });
    const result = await lab.inspectFrame('flow-0001', frame());
    expect(result).toMatchObject({
      decision: { action: 'ALLOW', evidenceComplete: true },
      receipt: { status: 'APPLIED', bytesForwardedBeforeDecision: 0 },
      reinjection: { flowId: 'flow-0001', egressInterface: 'p2' },
      bytesReleasedAfterDecision: Buffer.byteLength('inspect me'),
      palState: 'DECODING',
    });
    const batch = evidenceWal.createExportBatch(10);
    expect(batch?.records.map((item) => item.body.eventType)).toEqual([
      'FLOW_ADMISSION', 'ENFORCEMENT_DECISION', 'ENFORCEMENT_RECEIPT',
    ]);
    expect(verifyEvidenceRecords({
      records: batch?.records ?? [], expectedDeviceId: 'device-1', startingSequence: 1,
      previousRecordHash: 'GENESIS',
      keyResolver: (keyId) => keyId === 'evidence-key-1' ? evidenceKeys.publicKey : undefined,
    })).toBe(true);
  });

  it('turns a required engine failure into a terminal block without reinjection', async () => {
    const { lab } = subject({
      inspect: async () => { throw new Error('engine unavailable'); },
    });
    lab.openFlow(flow());
    const result = await lab.inspectFrame('flow-0001', frame());
    expect(result.decision).toMatchObject({
      action: 'BLOCK', terminal: true, reasonCode: 'REQUIRED_INSPECTION_ENGINE_FAILED',
    });
    expect(result.reinjection).toBeUndefined();
    expect(result.bytesReleasedAfterDecision).toBe(0);
    expect(result.receipt.bytesForwardedBeforeDecision).toBe(0);
    expect(lab.snapshot().activeFlowIds).toEqual([]);
  });

  it('returns every forwarded message to inspection before issuing a new authorization', async () => {
    const { lab } = subject();
    lab.openFlow(flow());
    const firstFrame = frame({ value: 'first' });
    const first = await lab.inspectFrame('flow-0001', firstFrame);
    const second = await lab.inspectFrame('flow-0001', frame({
      sequence: 1, offset: firstFrame.sizeBytes, value: 'second',
    }));
    expect(second.decision.frameSeq).toBe(1);
    expect(second.reinjection?.decisionId).not.toBe(first.reinjection?.decisionId);
    expect(lab.snapshot()).toMatchObject({
      activeFlowIds: ['flow-0001'],
      fastPath: { states: { 'flow-0001': 'FORWARDING' } },
      evidence: { retainedRecords: 5 },
    });
  });

  it('closes the flow when durable evidence capacity is insufficient', async () => {
    const { lab } = subject({ maximumEvidenceRecords: 2 });
    lab.openFlow(flow());
    await expect(lab.inspectFrame('flow-0001', frame()))
      .rejects.toThrow('VIRTUAL_LAB_EVIDENCE_CAPACITY_EXHAUSTED');
    expect(lab.snapshot()).toMatchObject({
      activeFlowIds: [],
      fastPath: { activeConnections: 0, states: {} },
      evidence: { retainedRecords: 2, protectedTrafficAdmissible: false },
    });
  });

  it('requires an explicit TLS handshake before accepting HTTPS content', async () => {
    const { lab } = subject();
    lab.openFlow(flow({ applicationProtocol: 'HTTPS' }));
    await expect(lab.inspectFrame('flow-0001', frame({ applicationProtocol: 'HTTPS' })))
      .rejects.toThrow('PAL_STATE_INVALID');
    expect(lab.snapshot().activeFlowIds).toEqual([]);

    const second = subject();
    second.lab.openFlow(flow({ applicationProtocol: 'HTTPS' }));
    second.lab.markTlsEstablished('flow-0001');
    await expect(second.lab.inspectFrame(
      'flow-0001', frame({ applicationProtocol: 'HTTPS' }),
    )).resolves.toMatchObject({ decision: { action: 'ALLOW' } });
  });
});
