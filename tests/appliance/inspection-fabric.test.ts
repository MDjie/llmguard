import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  FlowEnvelope,
  FrameEnvelope,
  NetworkObservation,
} from '../../packages/contracts-appliance/generated/typescript/appliance-v1';
import {
  InspectionFabric,
  PalV2FlowController,
  verifyEnforcementDecisionToken,
  type InspectionEngineAdapter,
} from '@/lib/appliance';

const NOW = 10_000;
const keys = generateKeyPairSync('ed25519');
const content = Buffer.from('inspect me');
const contentSha256 = createHash('sha256').update(content).digest('hex');

function flow(): FlowEnvelope {
  return {
    contractVersion: '1.0', deviceId: 'device-1', deviceGroupId: 'group-1',
    flowId: 'flow-0001', flowSeq: 1, tenantId: 'tenant-1', applicationId: 'app-1',
    deploymentMode: 'TRANSPARENT_INLINE', ingressInterface: 'p1', egressInterface: 'p2',
    source: { ip: '192.0.2.1', port: 50_000 },
    destination: { ip: '198.51.100.1', port: 443 }, transport: 'TCP',
    applicationProtocol: 'HTTP_1_1', direction: 'CLIENT_TO_SERVER', protectedTraffic: true,
    openedAtEpochMs: 9_000, absoluteDeadlineEpochMs: 20_000, policyBundleId: 'bundle-1',
  };
}

function frame(): FrameEnvelope {
  return {
    contractVersion: '1.0', flowId: 'flow-0001', frameId: 'frame-0001', flowSeq: 1,
    frameSeq: 0, direction: 'CLIENT_TO_SERVER', applicationProtocol: 'HTTP_1_1',
    protocolStage: 'MESSAGE', mediaType: 'text/plain', sizeBytes: content.length,
    sha256: contentSha256, streamOffsetStart: 0, streamOffsetEnd: content.length,
    absoluteDeadlineEpochMs: 15_000, policyBundleId: 'bundle-1',
    inlinePayloadBase64: content.toString('base64'),
  };
}

function observation(engineId: string, status: NetworkObservation['status'], score = 0) {
  return {
    engineId,
    engineType: engineId === 'ips' ? 'IPS' as const : 'AI_GUARD' as const,
    engineVersion: '1.0.0', ruleVersion: 'rules-1', status,
    riskType: status === 'MATCH' ? 'attack' : 'none',
    severity: status === 'MATCH' ? 'HIGH' as const : 'NONE' as const,
    score,
    evidenceDigest: createHash('sha256').update(engineId + status).digest('hex'),
  };
}

function adapter(
  engineId: 'ips' | 'guard',
  inspect: InspectionEngineAdapter['inspect'],
): InspectionEngineAdapter {
  return {
    engineId,
    engineType: engineId === 'ips' ? 'IPS' : 'AI_GUARD',
    engineVersion: '1.0.0',
    ruleVersion: 'rules-1',
    inspect,
  };
}

function fabric(adapters: readonly InspectionEngineAdapter[]) {
  return new InspectionFabric({
    policyBundleId: 'bundle-1', decisionTtlMs: 1_000,
    engines: [
      { engineId: 'ips', required: true, timeoutMs: 50, minimumMatchScore: 0.7,
        actionOnMatch: 'RESET' },
      { engineId: 'guard', required: false, timeoutMs: 50, minimumMatchScore: 0.7,
        actionOnMatch: 'BLOCK' },
    ],
  }, adapters, { signingKeyId: 'decision-key-1', privateKey: keys.privateKey, now: () => NOW });
}

describe('inspection fabric', () => {
  it('emits a signed allow decision that PAL can enforce', async () => {
    const subject = fabric([
      adapter('ips', async () => [observation('ips', 'NO_MATCH')]),
      adapter('guard', async () => [observation('guard', 'NO_MATCH')]),
    ]);
    const decision = await subject.inspect(flow(), frame());
    expect(decision).toMatchObject({ action: 'ALLOW', evidenceComplete: true, terminal: false });
    expect(verifyEnforcementDecisionToken(decision, () => keys.publicKey)).toBe(true);
    const pal = new PalV2FlowController(flow(), {
      now: () => NOW,
      verifyEnforcementToken: (candidate) =>
        verifyEnforcementDecisionToken(candidate, () => keys.publicKey),
    });
    pal.open();
    pal.submitFrame(frame());
    pal.applyDecision(decision);
    expect(pal.state).toBe('FORWARDING');
  });

  it('fails closed when a required engine errors', async () => {
    const subject = fabric([
      adapter('ips', async () => { throw new Error('engine down'); }),
      adapter('guard', async () => [observation('guard', 'NO_MATCH')]),
    ]);
    await expect(subject.inspect(flow(), frame())).resolves.toMatchObject({
      action: 'BLOCK', terminal: true, reasonCode: 'REQUIRED_INSPECTION_ENGINE_FAILED',
    });
  });

  it('allows an evidenced degradation for an explicitly optional engine', async () => {
    const subject = fabric([
      adapter('ips', async () => [observation('ips', 'NO_MATCH')]),
      adapter('guard', async () => { throw new Error('optional engine down'); }),
    ]);
    const decision = await subject.inspect(flow(), frame());
    expect(decision.action).toBe('ALLOW');
    expect(decision.observations.find((item) => item.engineId === 'guard')?.status).toBe('ERROR');
    expect(decision.evidenceComplete).toBe(true);
  });

  it('uses deterministic action precedence across matching engines', async () => {
    const subject = fabric([
      adapter('ips', async () => [observation('ips', 'MATCH', 0.9)]),
      adapter('guard', async () => [observation('guard', 'MATCH', 0.95)]),
    ]);
    const decision = await subject.inspect(flow(), frame());
    expect(decision.action).toBe('BLOCK');
    expect(decision.observations.map((item) => item.engineId)).toEqual(['guard', 'ips']);
  });

  it('converts invalid adapter output into a fail-closed engine error', async () => {
    const subject = fabric([
      adapter('ips', async () => [{ ...observation('ips', 'NO_MATCH'), engineVersion: 'wrong' }]),
      adapter('guard', async () => [observation('guard', 'NO_MATCH')]),
    ]);
    const decision = await subject.inspect(flow(), frame());
    expect(decision).toMatchObject({ action: 'BLOCK', reasonCode: 'REQUIRED_INSPECTION_ENGINE_FAILED' });
  });

  it('binds the token to every decision field', async () => {
    const subject = fabric([
      adapter('ips', async () => [observation('ips', 'NO_MATCH')]),
      adapter('guard', async () => [observation('guard', 'NO_MATCH')]),
    ]);
    const decision = await subject.inspect(flow(), frame());
    expect(verifyEnforcementDecisionToken(
      { ...decision, action: 'BLOCK' },
      () => keys.publicKey,
    )).toBe(false);
  });
});
