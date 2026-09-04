import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  GuardAction,
  GuardDecision,
  GuardEngine,
  GuardRequest,
} from '@/lib/guard-engine-v2';
import type { FlowEnvelope, FrameEnvelope } from '../../packages/contracts-appliance/generated/typescript/appliance-v1';
import { ApplianceGuardRuntimeAdapter, InspectionFabric } from '@/lib/appliance';

const NOW = 10_000;
const text = 'sensitive input';
const payload = Buffer.from(text);
const keys = generateKeyPairSync('ed25519');

function flow(): FlowEnvelope {
  return {
    contractVersion: '1.0', deviceId: 'device-1', deviceGroupId: 'group-1',
    flowId: 'flow-0001', flowSeq: 1, tenantId: 'tenant-1', applicationId: 'app-1',
    deploymentMode: 'REVERSE_PROXY', ingressInterface: 'p1', egressInterface: 'p2',
    source: { ip: '192.0.2.1', port: 50_000 }, destination: { ip: '198.51.100.1', port: 443 },
    transport: 'TCP', applicationProtocol: 'OPENAI_API', direction: 'CLIENT_TO_SERVER',
    protectedTraffic: true, openedAtEpochMs: 9_000, absoluteDeadlineEpochMs: 20_000,
    policyBundleId: 'bundle-1',
  };
}

function frame(overrides: Partial<FrameEnvelope> = {}): FrameEnvelope {
  return {
    contractVersion: '1.0', flowId: 'flow-0001', frameId: 'frame-0001', flowSeq: 1,
    frameSeq: 0, direction: 'CLIENT_TO_SERVER', applicationProtocol: 'OPENAI_API',
    protocolStage: 'MESSAGE', mediaType: 'application/json', sizeBytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'), streamOffsetStart: 0,
    streamOffsetEnd: payload.length, absoluteDeadlineEpochMs: 15_000,
    policyBundleId: 'bundle-1', inlinePayloadBase64: payload.toString('base64'), ...overrides,
  };
}

function decision(action: GuardAction, overrides: Partial<GuardDecision> = {}): GuardDecision {
  return {
    contractVersion: '1.0', decisionId: 'guard-decision-1', traceId: 'flow-0001', action,
    riskLevel: action === 'ALLOW' ? 'NONE' : 'HIGH', observations: [],
    policyPath: ['policy-1'], bundleId: 'bundle-1', latencyMs: 2,
    degradationReasons: [], failMode: 'NORMAL', evidenceComplete: true,
    ...(action === 'MASK' ? { transformedText: '[MASKED]' } : {}), ...overrides,
  };
}

function engine(result: GuardDecision, capture?: (request: GuardRequest) => void): GuardEngine {
  return { evaluate: async (request) => { capture?.(request); return result; } };
}

function fabric(result: GuardDecision) {
  const adapter = new ApplianceGuardRuntimeAdapter({
    engineId: 'guard-runtime', engineVersion: '2.0.0', ruleVersion: 'rules-7',
    guardEngine: engine(result),
  });
  return new InspectionFabric({
    policyBundleId: 'bundle-1', decisionTtlMs: 1_000,
    engines: [{ engineId: 'guard-runtime', required: true, timeoutMs: 100,
      minimumMatchScore: 0.7, actionOnMatch: 'BLOCK' }],
  }, [adapter], { signingKeyId: 'decision-key', privateKey: keys.privateKey, now: () => NOW });
}

describe('appliance Guard Runtime adapter', () => {
  it('maps the network identity and deadline into the Guard v1 request', async () => {
    let captured: GuardRequest | undefined;
    const adapter = new ApplianceGuardRuntimeAdapter({
      engineId: 'guard-runtime', engineVersion: '2.0.0', ruleVersion: 'rules-7',
      guardEngine: engine(decision('ALLOW'), (request) => { captured = request; }),
    });
    await adapter.inspect({ flow: flow(), frame: frame(), signal: new AbortController().signal });
    expect(captured).toMatchObject({
      context: {
        traceId: 'flow-0001', requestId: 'frame-0001', tenantId: 'tenant-1',
        applicationId: 'app-1', direction: 'INPUT', policyBundleId: 'bundle-1',
      },
      content: { text },
    });
  });

  it('preserves an authoritative Guard block in the enforceable decision', async () => {
    await expect(fabric(decision('BLOCK')).inspect(flow(), frame())).resolves.toMatchObject({
      action: 'BLOCK', terminal: true, guardDecisionId: 'guard-decision-1',
    });
  });

  it('preserves a Guard mask and transformed payload', async () => {
    const result = await fabric(decision('MASK')).inspect(flow(), frame());
    expect(result).toMatchObject({ action: 'MASK', guardDecisionId: 'guard-decision-1' });
    expect(Buffer.from(result.transformedPayloadBase64 ?? '', 'base64').toString('utf8'))
      .toBe('[MASKED]');
  });

  it('converts an invalid Guard decision into required-engine fail closed', async () => {
    const result = await fabric(decision('ALLOW', { evidenceComplete: false })).inspect(flow(), frame());
    expect(result).toMatchObject({
      action: 'BLOCK', reasonCode: 'REQUIRED_INSPECTION_ENGINE_FAILED',
    });
  });

  it('rejects content references and digest mismatches until a trusted resolver is configured', async () => {
    const adapter = new ApplianceGuardRuntimeAdapter({
      engineId: 'guard-runtime', engineVersion: '2.0.0', ruleVersion: 'rules-7',
      guardEngine: engine(decision('ALLOW')),
    });
    await expect(adapter.inspect({
      flow: flow(),
      frame: frame({ sha256: '0'.repeat(64) }),
      signal: new AbortController().signal,
    })).rejects.toThrow('GUARD_RUNTIME_FRAME_DIGEST_MISMATCH');
  });
});
