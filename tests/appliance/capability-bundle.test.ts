import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  HealthComponent,
} from '../../packages/contracts-appliance/generated/typescript/appliance-v1';
import {
  AppliancePolicyAgent,
  signApplianceBundle,
  validateApplianceBundle,
  type ApplianceBundlePayload,
} from '../../src/lib/appliance/appliance-bundle';
import {
  bindCapabilityManifest,
  createHealthSnapshot,
  healthSnapshotDigest,
  validateCapabilityManifest,
  validateHealthSnapshot,
} from '../../src/lib/appliance/capability';

const NOW = 10_000;
const RAW_DIGEST = 'a'.repeat(64);
const PREFIXED_DIGEST = `sha256:${RAW_DIGEST}`;

function capability(
  overrides: Partial<Omit<CapabilityManifest, 'manifestDigest'>> = {},
): CapabilityManifest {
  return bindCapabilityManifest({
    contractVersion: '1.0',
    deviceId: 'device-01',
    deviceGroupId: 'group-01',
    generation: 1,
    reportedAtEpochMs: NOW,
    softwareVersion: '1.0.0',
    softwareDigest: PREFIXED_DIGEST,
    deploymentModes: ['REVERSE_PROXY', 'TRANSPARENT_INLINE'],
    engines: [{
      engineId: 'guard-runtime',
      engineType: 'AI_GUARD',
      version: '1.0.0',
      artifactSha256: RAW_DIGEST,
      protocols: ['HTTP_1_1', 'HTTPS', 'OPENAI_API'],
      actions: ['ALLOW', 'BLOCK', 'MASK', 'REWRITE'],
    }],
    hardware: {
      cpuArchitecture: 'x86_64',
      cpuModel: 'test-cpu',
      memoryBytes: 64 * 1024 * 1024 * 1024,
      nicModels: ['test-nic'],
      acceleratorModels: ['test-accelerator'],
      driverDigests: [PREFIXED_DIGEST],
      firmwareDigests: [PREFIXED_DIGEST],
      physicalBypassAvailable: true,
      trustedKeyDeviceAvailable: true,
    },
    ...overrides,
  });
}

function bundle(generation = 1): ApplianceBundlePayload {
  return {
    schemaVersion: '1.0',
    bundleId: `appliance-bundle-${generation}`,
    generation,
    deviceGroupId: 'group-01',
    issuedAtEpochMs: 9_000,
    expiresAtEpochMs: 20_000,
    minimumSoftwareVersion: '1.0.0',
    requiredDeploymentModes: ['TRANSPARENT_INLINE'],
    requiredEngines: [{
      engineId: 'guard-runtime',
      engineType: 'AI_GUARD',
      artifactSha256: RAW_DIGEST,
    }],
    requirePhysicalBypass: true,
    requireTrustedKeyDevice: true,
    networkPolicyDigest: PREFIXED_DIGEST,
    tlsPolicyDigest: PREFIXED_DIGEST,
    guardPolicyBundleDigest: PREFIXED_DIGEST,
    observabilityPolicyDigest: PREFIXED_DIGEST,
    ...(generation > 1 ? { rollbackBundleId: `appliance-bundle-${generation - 1}` } : {}),
  };
}

describe('B-WP09 capability and health evidence', () => {
  it('binds a capability manifest to hardware, software and engine identities', () => {
    const manifest = capability();
    expect(validateCapabilityManifest(manifest)).toEqual({
      valid: true,
      reasonCode: 'CAPABILITY_VALID',
    });
    expect(validateCapabilityManifest({
      ...manifest,
      softwareVersion: 'tampered',
    }).reasonCode).toBe('CAPABILITY_DIGEST_INVALID');
  });

  it('uses the most severe component health action and detects tampering', () => {
    const components: readonly HealthComponent[] = [{
      componentId: 'cpu',
      action: 'DEGRADE',
      reasonCodes: ['CPU_SATURATED'],
      utilization: 0.92,
    }, {
      componentId: 'nic-1',
      action: 'DRAIN',
      reasonCodes: ['NIC_LINK_DOWN'],
    }];
    const snapshot = createHealthSnapshot({
      deviceId: 'device-01',
      generation: 1,
      capturedAtEpochMs: NOW,
      components,
    });
    expect(snapshot.action).toBe('DRAIN');
    expect(validateHealthSnapshot(snapshot)).toBe(true);
    expect(validateHealthSnapshot({ ...snapshot, action: 'HEALTHY' })).toBe(false);
    const empty = {
      deviceId: 'device-01', generation: 1, capturedAtEpochMs: NOW,
      action: 'HEALTHY' as const, components: [],
    };
    expect(validateHealthSnapshot({
      ...empty, snapshotDigest: healthSnapshotDigest(empty),
    })).toBe(false);
  });
});

describe('B-WP08 signed appliance bundle agent', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  it('prepares and atomically activates only a signed capability-compatible bundle', () => {
    const signed = signApplianceBundle(bundle(), {
      signingKeyId: 'policy-key-01',
      privateKey,
    });
    expect(validateApplianceBundle({
      bundle: signed,
      capability: capability(),
      nowEpochMs: NOW,
      activeGeneration: 0,
      keyResolver: () => publicKey,
    })).toEqual({ valid: true, reasonCode: 'APPLIANCE_BUNDLE_VALID' });

    const agent = new AppliancePolicyAgent(
      'device-01',
      capability(),
      () => publicKey,
      () => NOW,
    );
    expect(agent.prepare(signed)).toMatchObject({
      status: 'PREPARED',
      bundleId: 'appliance-bundle-1',
    });
    expect(agent.activeBundle()).toBeUndefined();
    expect(agent.activate('appliance-bundle-1')).toMatchObject({ status: 'ACTIVE' });
    expect(agent.activeBundle()?.payload.generation).toBe(1);
  });

  it('rejects tampering, missing hardware and stale generations', () => {
    const signed = signApplianceBundle(bundle(), {
      signingKeyId: 'policy-key-01',
      privateKey,
    });
    expect(validateApplianceBundle({
      bundle: { ...signed, contentHash: 'b'.repeat(64) },
      capability: capability(),
      nowEpochMs: NOW,
      activeGeneration: 0,
      keyResolver: () => publicKey,
    }).reasonCode).toBe('APPLIANCE_BUNDLE_HASH_INVALID');
    expect(validateApplianceBundle({
      bundle: signed,
      capability: capability({
        hardware: {
          ...capability().hardware,
          physicalBypassAvailable: false,
        },
      }),
      nowEpochMs: NOW,
      activeGeneration: 0,
      keyResolver: () => publicKey,
    }).reasonCode).toBe('APPLIANCE_BUNDLE_HARDWARE_UNAVAILABLE');
    expect(validateApplianceBundle({
      bundle: signed,
      capability: capability(),
      nowEpochMs: NOW,
      activeGeneration: 1,
      keyResolver: () => publicKey,
    }).reasonCode).toBe('APPLIANCE_BUNDLE_GENERATION_STALE');
  });

  it('rejects stale capabilities and software below the bundle minimum', () => {
    const newerSoftware = signApplianceBundle({
      ...bundle(), minimumSoftwareVersion: '2.0.0',
    }, { signingKeyId: 'policy-key-01', privateKey });
    expect(validateApplianceBundle({
      bundle: newerSoftware, capability: capability(), nowEpochMs: NOW,
      activeGeneration: 0, keyResolver: () => publicKey,
    }).reasonCode).toBe('APPLIANCE_BUNDLE_SOFTWARE_VERSION_UNAVAILABLE');

    const current = signApplianceBundle(bundle(), {
      signingKeyId: 'policy-key-01', privateKey,
    });
    expect(validateApplianceBundle({
      bundle: current, capability: capability({ reportedAtEpochMs: NOW - 101 }),
      nowEpochMs: NOW, activeGeneration: 0, maximumCapabilityAgeMs: 100,
      keyResolver: () => publicKey,
    }).reasonCode).toBe('APPLIANCE_BUNDLE_CAPABILITY_STALE');
  });

  it('retains one verified generation for an explicit rollback', () => {
    const agent = new AppliancePolicyAgent(
      'device-01',
      capability(),
      () => publicKey,
      () => NOW,
    );
    const first = signApplianceBundle(bundle(1), {
      signingKeyId: 'policy-key-01',
      privateKey,
    });
    const second = signApplianceBundle(bundle(2), {
      signingKeyId: 'policy-key-01',
      privateKey,
    });
    agent.prepare(first);
    agent.activate(first.payload.bundleId);
    agent.prepare(second);
    agent.activate(second.payload.bundleId);
    expect(agent.activeBundle()?.payload.generation).toBe(2);
    expect(agent.rollback('HEALTH_GATE_FAILED')).toMatchObject({
      status: 'ROLLED_BACK',
      reasonCode: 'HEALTH_GATE_FAILED',
    });
    expect(agent.activeBundle()?.payload.generation).toBe(1);
  });
});
