import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type {
  BundleActivationReceipt,
  CapabilityManifest,
  DeploymentMode,
  EngineType,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';
import { validateCapabilityManifest } from './capability';

type SigningKey = string | Buffer | KeyObject;

export interface ApplianceEngineRequirement {
  readonly engineId: string;
  readonly engineType: EngineType;
  readonly artifactSha256: string;
}

export interface ApplianceBundlePayload {
  readonly schemaVersion: '1.0';
  readonly bundleId: string;
  readonly generation: number;
  readonly deviceGroupId: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly minimumSoftwareVersion: string;
  readonly requiredDeploymentModes: readonly DeploymentMode[];
  readonly requiredEngines: readonly ApplianceEngineRequirement[];
  readonly requirePhysicalBypass: boolean;
  readonly requireTrustedKeyDevice: boolean;
  readonly networkPolicyDigest: string;
  readonly tlsPolicyDigest: string;
  readonly guardPolicyBundleDigest: string;
  readonly observabilityPolicyDigest: string;
  readonly rollbackBundleId?: string;
}

export interface SignedApplianceBundle {
  readonly payload: ApplianceBundlePayload;
  readonly canonicalJson: string;
  readonly contentHash: string;
  readonly signature: string;
  readonly signatureAlgorithm: 'Ed25519';
  readonly signingKeyId: string;
}

export type ApplianceBundleValidationCode =
  | 'APPLIANCE_BUNDLE_VALID'
  | 'APPLIANCE_BUNDLE_STRUCTURE_INVALID'
  | 'APPLIANCE_BUNDLE_HASH_INVALID'
  | 'APPLIANCE_BUNDLE_SIGNATURE_INVALID'
  | 'APPLIANCE_BUNDLE_KEY_UNAVAILABLE'
  | 'APPLIANCE_BUNDLE_NOT_YET_VALID'
  | 'APPLIANCE_BUNDLE_EXPIRED'
  | 'APPLIANCE_BUNDLE_GENERATION_STALE'
  | 'APPLIANCE_BUNDLE_DEVICE_GROUP_MISMATCH'
  | 'APPLIANCE_BUNDLE_CAPABILITY_INVALID'
  | 'APPLIANCE_BUNDLE_CAPABILITY_STALE'
  | 'APPLIANCE_BUNDLE_SOFTWARE_VERSION_UNAVAILABLE'
  | 'APPLIANCE_BUNDLE_MODE_UNAVAILABLE'
  | 'APPLIANCE_BUNDLE_ENGINE_UNAVAILABLE'
  | 'APPLIANCE_BUNDLE_HARDWARE_UNAVAILABLE';

export interface ApplianceBundleValidation {
  readonly valid: boolean;
  readonly reasonCode: ApplianceBundleValidationCode;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SOFTWARE_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const DEFAULT_MAXIMUM_CAPABILITY_AGE_MS = 5 * 60_000;

function semanticVersion(value: string): readonly [number, number, number] | undefined {
  const match = SOFTWARE_VERSION_PATTERN.exec(value);
  if (!match) return undefined;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parsed.every((part) => Number.isSafeInteger(part)) ? parsed : undefined;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = semanticVersion(actual);
  const right = semanticVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

function asPrivateKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPrivateKey(key) : key;
}

function asPublicKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : key;
}

function bundleIsStructurallyValid(payload: ApplianceBundlePayload): boolean {
  const digests = [
    payload.networkPolicyDigest,
    payload.tlsPolicyDigest,
    payload.guardPolicyBundleDigest,
    payload.observabilityPolicyDigest,
  ];
  return payload.schemaVersion === '1.0' && payload.bundleId.length > 0 &&
    Number.isSafeInteger(payload.generation) && payload.generation > 0 &&
    payload.deviceGroupId.length > 0 && Number.isSafeInteger(payload.issuedAtEpochMs) &&
    payload.issuedAtEpochMs > 0 && Number.isSafeInteger(payload.expiresAtEpochMs) &&
    payload.expiresAtEpochMs > payload.issuedAtEpochMs &&
    SOFTWARE_VERSION_PATTERN.test(payload.minimumSoftwareVersion) &&
    payload.requiredDeploymentModes.length > 0 &&
    new Set(payload.requiredDeploymentModes).size === payload.requiredDeploymentModes.length &&
    new Set(payload.requiredEngines.map((engine) => engine.engineId)).size ===
      payload.requiredEngines.length &&
    payload.requiredEngines.every((engine) => engine.engineId.length > 0 &&
      /^[a-f0-9]{64}$/u.test(engine.artifactSha256)) &&
    digests.every((digest) => SHA256_PATTERN.test(digest));
}

export function signApplianceBundle(
  payload: ApplianceBundlePayload,
  options: { readonly signingKeyId: string; readonly privateKey: SigningKey },
): SignedApplianceBundle {
  if (!bundleIsStructurallyValid(payload) || options.signingKeyId.length === 0) {
    throw new Error('APPLIANCE_BUNDLE_STRUCTURE_INVALID');
  }
  const serialized = canonicalJson(payload);
  return {
    payload,
    canonicalJson: serialized,
    contentHash: createHash('sha256').update(serialized).digest('hex'),
    signature: sign(null, Buffer.from(serialized), asPrivateKey(options.privateKey))
      .toString('base64url'),
    signatureAlgorithm: 'Ed25519',
    signingKeyId: options.signingKeyId,
  };
}

export function validateApplianceBundle(input: {
  readonly bundle: SignedApplianceBundle;
  readonly capability: CapabilityManifest;
  readonly nowEpochMs: number;
  readonly activeGeneration: number;
  readonly maximumCapabilityAgeMs?: number;
  readonly keyResolver: (keyId: string) => SigningKey | undefined;
}): ApplianceBundleValidation {
  const { bundle, capability } = input;
  if (!bundleIsStructurallyValid(bundle.payload) || bundle.signatureAlgorithm !== 'Ed25519') {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_STRUCTURE_INVALID' };
  }
  const serialized = canonicalJson(bundle.payload);
  const hash = createHash('sha256').update(serialized).digest('hex');
  if (hash !== bundle.contentHash || serialized !== bundle.canonicalJson) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_HASH_INVALID' };
  }
  const key = input.keyResolver(bundle.signingKeyId);
  if (!key) return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_KEY_UNAVAILABLE' };
  try {
    if (!verify(null, Buffer.from(serialized), asPublicKey(key),
      Buffer.from(bundle.signature, 'base64url'))) {
      return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_SIGNATURE_INVALID' };
    }
  } catch {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_SIGNATURE_INVALID' };
  }
  if (bundle.payload.issuedAtEpochMs > input.nowEpochMs) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_NOT_YET_VALID' };
  }
  if (bundle.payload.expiresAtEpochMs <= input.nowEpochMs) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_EXPIRED' };
  }
  if (bundle.payload.generation <= input.activeGeneration) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_GENERATION_STALE' };
  }
  if (bundle.payload.deviceGroupId !== capability.deviceGroupId) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_DEVICE_GROUP_MISMATCH' };
  }
  if (!validateCapabilityManifest(capability).valid) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_CAPABILITY_INVALID' };
  }
  const maximumCapabilityAgeMs = input.maximumCapabilityAgeMs ??
    DEFAULT_MAXIMUM_CAPABILITY_AGE_MS;
  if (!Number.isSafeInteger(maximumCapabilityAgeMs) || maximumCapabilityAgeMs < 1 ||
      capability.reportedAtEpochMs > input.nowEpochMs ||
      input.nowEpochMs - capability.reportedAtEpochMs > maximumCapabilityAgeMs) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_CAPABILITY_STALE' };
  }
  if (!versionAtLeast(capability.softwareVersion, bundle.payload.minimumSoftwareVersion)) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_SOFTWARE_VERSION_UNAVAILABLE' };
  }
  if (bundle.payload.requiredDeploymentModes.some(
    (mode) => !capability.deploymentModes.includes(mode),
  )) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_MODE_UNAVAILABLE' };
  }
  for (const requirement of bundle.payload.requiredEngines) {
    const engine = capability.engines.find((candidate) =>
      candidate.engineId === requirement.engineId &&
      candidate.engineType === requirement.engineType &&
      candidate.artifactSha256 === requirement.artifactSha256);
    if (!engine) return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_ENGINE_UNAVAILABLE' };
  }
  if ((bundle.payload.requirePhysicalBypass &&
      !capability.hardware.physicalBypassAvailable) ||
      (bundle.payload.requireTrustedKeyDevice &&
        !capability.hardware.trustedKeyDeviceAvailable)) {
    return { valid: false, reasonCode: 'APPLIANCE_BUNDLE_HARDWARE_UNAVAILABLE' };
  }
  return { valid: true, reasonCode: 'APPLIANCE_BUNDLE_VALID' };
}

function receiptDigest(
  receipt: Omit<BundleActivationReceipt, 'receiptDigest'>,
): string {
  return createHash('sha256').update(canonicalJson(receipt)).digest('hex');
}

export class AppliancePolicyAgent {
  private active: SignedApplianceBundle | undefined;
  private previous: SignedApplianceBundle | undefined;
  private prepared: SignedApplianceBundle | undefined;

  constructor(
    private readonly deviceId: string,
    private readonly capability: CapabilityManifest,
    private readonly keyResolver: (keyId: string) => SigningKey | undefined,
    private readonly now: () => number = Date.now,
  ) {
    if (deviceId.length === 0 || capability.deviceId !== deviceId ||
        !validateCapabilityManifest(capability).valid) {
      throw new Error('APPLIANCE_AGENT_CAPABILITY_INVALID');
    }
  }

  prepare(bundle: SignedApplianceBundle): BundleActivationReceipt {
    const validation = validateApplianceBundle({
      bundle,
      capability: this.capability,
      nowEpochMs: this.now(),
      activeGeneration: this.active?.payload.generation ?? 0,
      keyResolver: this.keyResolver,
    });
    if (!validation.valid) return this.receipt(bundle, 'REJECTED', validation.reasonCode);
    this.prepared = bundle;
    return this.receipt(bundle, 'PREPARED');
  }

  activate(bundleId: string): BundleActivationReceipt {
    if (!this.prepared || this.prepared.payload.bundleId !== bundleId) {
      throw new Error('APPLIANCE_BUNDLE_NOT_PREPARED');
    }
    if (this.prepared.payload.expiresAtEpochMs <= this.now()) {
      const expired = this.prepared;
      this.prepared = undefined;
      return this.receipt(expired, 'REJECTED', 'APPLIANCE_BUNDLE_EXPIRED');
    }
    this.previous = this.active;
    this.active = this.prepared;
    this.prepared = undefined;
    return this.receipt(this.active, 'ACTIVE');
  }

  rollback(reasonCode: string): BundleActivationReceipt {
    if (!this.active || !this.previous || reasonCode.length === 0) {
      throw new Error('APPLIANCE_ROLLBACK_UNAVAILABLE');
    }
    const rolledBack = this.active;
    this.active = this.previous;
    this.previous = undefined;
    this.prepared = undefined;
    return this.receipt(rolledBack, 'ROLLED_BACK', reasonCode);
  }

  activeBundle(): SignedApplianceBundle | undefined {
    return this.active;
  }

  previousBundle(): SignedApplianceBundle | undefined {
    return this.previous;
  }

  private receipt(
    bundle: SignedApplianceBundle,
    status: BundleActivationReceipt['status'],
    reasonCode?: string,
  ): BundleActivationReceipt {
    const componentDigests = {
      networkPolicy: bundle.payload.networkPolicyDigest,
      tlsPolicy: bundle.payload.tlsPolicyDigest,
      guardPolicy: bundle.payload.guardPolicyBundleDigest,
      observabilityPolicy: bundle.payload.observabilityPolicyDigest,
      ...Object.fromEntries(bundle.payload.requiredEngines.map(
        (engine) => ['engine:' + engine.engineId, 'sha256:' + engine.artifactSha256],
      )),
    };
    const unsigned: Omit<BundleActivationReceipt, 'receiptDigest'> = {
      deviceId: this.deviceId,
      bundleId: bundle.payload.bundleId,
      generation: bundle.payload.generation,
      bundleDigest: 'sha256:' + bundle.contentHash,
      status,
      ...(reasonCode ? { reasonCode } : {}),
      componentDigests,
      recordedAtEpochMs: this.now(),
    };
    return { ...unsigned, receiptDigest: receiptDigest(unsigned) };
  }
}
