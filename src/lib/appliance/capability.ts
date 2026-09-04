import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type {
  CapabilityManifest,
  HealthAction,
  HealthComponent,
  HealthSnapshot,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RAW_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HEALTH_PRECEDENCE: Readonly<Record<HealthAction, number>> = {
  HEALTHY: 0,
  DEGRADE: 1,
  DRAIN: 2,
  ISOLATE: 3,
  FAILOVER: 4,
};

export type CapabilityValidationCode =
  | 'CAPABILITY_VALID'
  | 'CAPABILITY_IDENTITY_INVALID'
  | 'CAPABILITY_GENERATION_INVALID'
  | 'CAPABILITY_SOFTWARE_IDENTITY_INVALID'
  | 'CAPABILITY_DUPLICATE_MODE'
  | 'CAPABILITY_DUPLICATE_ENGINE'
  | 'CAPABILITY_ENGINE_INVALID'
  | 'CAPABILITY_HARDWARE_INVALID'
  | 'CAPABILITY_DIGEST_INVALID';

export interface CapabilityValidation {
  readonly valid: boolean;
  readonly reasonCode: CapabilityValidationCode;
}

type UnsignedCapabilityManifest = Omit<CapabilityManifest, 'manifestDigest'>;
type UnsignedHealthSnapshot = Omit<HealthSnapshot, 'snapshotDigest'>;

function rawDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function capabilityManifestDigest(manifest: UnsignedCapabilityManifest): string {
  return rawDigest(manifest);
}

export function bindCapabilityManifest(
  manifest: UnsignedCapabilityManifest,
): CapabilityManifest {
  return { ...manifest, manifestDigest: capabilityManifestDigest(manifest) };
}

export function validateCapabilityManifest(manifest: CapabilityManifest): CapabilityValidation {
  if (manifest.contractVersion !== '1.0' || manifest.deviceId.length === 0 ||
      manifest.deviceGroupId.length === 0) {
    return { valid: false, reasonCode: 'CAPABILITY_IDENTITY_INVALID' };
  }
  if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1 ||
      !Number.isSafeInteger(manifest.reportedAtEpochMs) || manifest.reportedAtEpochMs < 1) {
    return { valid: false, reasonCode: 'CAPABILITY_GENERATION_INVALID' };
  }
  if (manifest.softwareVersion.length === 0 || !SHA256_PATTERN.test(manifest.softwareDigest)) {
    return { valid: false, reasonCode: 'CAPABILITY_SOFTWARE_IDENTITY_INVALID' };
  }
  if (manifest.deploymentModes.length === 0 ||
      new Set(manifest.deploymentModes).size !== manifest.deploymentModes.length) {
    return { valid: false, reasonCode: 'CAPABILITY_DUPLICATE_MODE' };
  }
  const engineIds = manifest.engines.map((engine) => engine.engineId);
  if (new Set(engineIds).size !== engineIds.length) {
    return { valid: false, reasonCode: 'CAPABILITY_DUPLICATE_ENGINE' };
  }
  if (manifest.engines.some((engine) => engine.engineId.length === 0 ||
      engine.version.length === 0 || !RAW_SHA256_PATTERN.test(engine.artifactSha256) ||
      engine.protocols.length === 0 || new Set(engine.protocols).size !== engine.protocols.length ||
      engine.actions.length === 0 || new Set(engine.actions).size !== engine.actions.length)) {
    return { valid: false, reasonCode: 'CAPABILITY_ENGINE_INVALID' };
  }
  const hardware = manifest.hardware;
  if (hardware.cpuArchitecture.length === 0 || hardware.cpuModel.length === 0 ||
      !Number.isSafeInteger(hardware.memoryBytes) || hardware.memoryBytes < 1 ||
      hardware.nicModels.length === 0 || hardware.nicModels.some((model) => model.length === 0) ||
      hardware.driverDigests.length === 0 ||
      hardware.driverDigests.some((digest) => !SHA256_PATTERN.test(digest)) ||
      hardware.firmwareDigests.length === 0 ||
      hardware.firmwareDigests.some((digest) => !SHA256_PATTERN.test(digest))) {
    return { valid: false, reasonCode: 'CAPABILITY_HARDWARE_INVALID' };
  }
  const { manifestDigest, ...unsigned } = manifest;
  if (!RAW_SHA256_PATTERN.test(manifestDigest) ||
      capabilityManifestDigest(unsigned) !== manifestDigest) {
    return { valid: false, reasonCode: 'CAPABILITY_DIGEST_INVALID' };
  }
  return { valid: true, reasonCode: 'CAPABILITY_VALID' };
}

function validateHealthComponent(component: HealthComponent): void {
  if (component.componentId.length === 0 || new Set(component.reasonCodes).size !==
      component.reasonCodes.length || component.reasonCodes.some((code) => code.length === 0) ||
      (component.utilization !== undefined &&
        (!Number.isFinite(component.utilization) || component.utilization < 0 ||
          component.utilization > 1)) ||
      (component.queueDepth !== undefined &&
        (!Number.isSafeInteger(component.queueDepth) || component.queueDepth < 0)) ||
      (component.temperatureCelsius !== undefined &&
        (!Number.isFinite(component.temperatureCelsius) ||
          component.temperatureCelsius < -100 || component.temperatureCelsius > 250))) {
    throw new Error('HEALTH_COMPONENT_INVALID');
  }
}

export function healthSnapshotDigest(snapshot: UnsignedHealthSnapshot): string {
  return rawDigest(snapshot);
}

export function createHealthSnapshot(input: {
  readonly deviceId: string;
  readonly generation: number;
  readonly capturedAtEpochMs: number;
  readonly components: readonly HealthComponent[];
}): HealthSnapshot {
  if (input.deviceId.length === 0 || !Number.isSafeInteger(input.generation) ||
      input.generation < 1 || !Number.isSafeInteger(input.capturedAtEpochMs) ||
      input.capturedAtEpochMs < 1 || input.components.length === 0) {
    throw new Error('HEALTH_SNAPSHOT_INVALID');
  }
  for (const component of input.components) validateHealthComponent(component);
  const componentIds = input.components.map((component) => component.componentId);
  if (new Set(componentIds).size !== componentIds.length) {
    throw new Error('HEALTH_COMPONENT_DUPLICATE');
  }
  const action = input.components.reduce<HealthAction>(
    (current, component) => HEALTH_PRECEDENCE[component.action] > HEALTH_PRECEDENCE[current]
      ? component.action
      : current,
    'HEALTHY',
  );
  const unsigned: UnsignedHealthSnapshot = { ...input, action };
  return { ...unsigned, snapshotDigest: healthSnapshotDigest(unsigned) };
}

export function validateHealthSnapshot(snapshot: HealthSnapshot): boolean {
  try {
    if (snapshot.deviceId.length === 0 || !Number.isSafeInteger(snapshot.generation) ||
        snapshot.generation < 1 || !Number.isSafeInteger(snapshot.capturedAtEpochMs) ||
        snapshot.capturedAtEpochMs < 1 || snapshot.components.length === 0 ||
        new Set(snapshot.components.map((component) => component.componentId)).size !==
          snapshot.components.length) {
      return false;
    }
    for (const component of snapshot.components) validateHealthComponent(component);
    const { snapshotDigest, ...unsigned } = snapshot;
    const expectedAction = snapshot.components.reduce<HealthAction>(
      (current, component) => HEALTH_PRECEDENCE[component.action] > HEALTH_PRECEDENCE[current]
        ? component.action
        : current,
      'HEALTHY',
    );
    return RAW_SHA256_PATTERN.test(snapshotDigest) && snapshot.action === expectedAction &&
      healthSnapshotDigest(unsigned) === snapshotDigest;
  } catch {
    return false;
  }
}
