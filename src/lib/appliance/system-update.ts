import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type { HealthSnapshot } from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';
import { validateHealthSnapshot } from './capability';

type SigningKey = string | Buffer | KeyObject;
export type SystemSlot = 'A' | 'B';
export type SystemUpdateState =
  | 'IDLE'
  | 'STAGED'
  | 'BOOT_PENDING'
  | 'HEALTH_VALIDATION'
  | 'COMMITTED'
  | 'ROLLED_BACK';

export interface SystemImageManifest {
  readonly schemaVersion: '1.0';
  readonly releaseId: string;
  readonly version: string;
  readonly generation: number;
  readonly imageDigest: string;
  readonly bootDigest: string;
  readonly componentDigests: Readonly<Record<string, string>>;
  readonly supportedHardwareIds: readonly string[];
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly healthConfirmationTimeoutMs: number;
}

export interface SignedSystemImageManifest {
  readonly payload: SystemImageManifest;
  readonly contentHash: string;
  readonly signatureAlgorithm: 'Ed25519';
  readonly signingKeyId: string;
  readonly signature: string;
}

export interface SystemUpdateReceipt {
  readonly deviceId: string;
  readonly releaseId: string;
  readonly generation: number;
  readonly previousSlot: SystemSlot;
  readonly targetSlot: SystemSlot;
  readonly state: SystemUpdateState;
  readonly reasonCode: string;
  readonly recordedAtEpochMs: number;
  readonly receiptDigest: string;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function asPrivateKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPrivateKey(key) : key;
}

function asPublicKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : key;
}

function manifestValid(manifest: SystemImageManifest): boolean {
  return manifest.schemaVersion === '1.0' && manifest.releaseId.length > 0 &&
    manifest.version.length > 0 && Number.isSafeInteger(manifest.generation) &&
    manifest.generation > 0 && DIGEST_PATTERN.test(manifest.imageDigest) &&
    DIGEST_PATTERN.test(manifest.bootDigest) &&
    Object.keys(manifest.componentDigests).length > 0 &&
    Object.values(manifest.componentDigests).every((value) => DIGEST_PATTERN.test(value)) &&
    manifest.supportedHardwareIds.length > 0 &&
    new Set(manifest.supportedHardwareIds).size === manifest.supportedHardwareIds.length &&
    manifest.supportedHardwareIds.every((value) => value.length > 0) &&
    Number.isSafeInteger(manifest.issuedAtEpochMs) && manifest.issuedAtEpochMs > 0 &&
    Number.isSafeInteger(manifest.expiresAtEpochMs) &&
    manifest.expiresAtEpochMs > manifest.issuedAtEpochMs &&
    Number.isSafeInteger(manifest.healthConfirmationTimeoutMs) &&
    manifest.healthConfirmationTimeoutMs > 0;
}

export function signSystemImageManifest(
  payload: SystemImageManifest,
  options: { readonly signingKeyId: string; readonly privateKey: SigningKey },
): SignedSystemImageManifest {
  if (!manifestValid(payload) || options.signingKeyId.length === 0) {
    throw new Error('SYSTEM_IMAGE_MANIFEST_INVALID');
  }
  const serialized = canonicalJson(payload);
  return {
    payload,
    contentHash: digest(payload),
    signatureAlgorithm: 'Ed25519',
    signingKeyId: options.signingKeyId,
    signature: sign(null, Buffer.from(serialized), asPrivateKey(options.privateKey))
      .toString('base64url'),
  };
}

export function verifySystemImageManifest(
  manifest: SignedSystemImageManifest,
  keyResolver: (keyId: string) => SigningKey | undefined,
): boolean {
  if (!manifestValid(manifest.payload) || manifest.signatureAlgorithm !== 'Ed25519' ||
      manifest.contentHash !== digest(manifest.payload)) return false;
  const key = keyResolver(manifest.signingKeyId);
  if (!key) return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(manifest.payload)),
      asPublicKey(key),
      Buffer.from(manifest.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

interface StagedUpdate {
  readonly manifest: SignedSystemImageManifest;
  readonly targetSlot: SystemSlot;
  readonly stagedImageDigest: string;
  bootDeadlineEpochMs?: number;
}

/** A/B lifecycle authority; platform adapters perform the actual slot writes and reboot. */
export class AbSystemUpdater {
  private state: SystemUpdateState = 'IDLE';
  private staged: StagedUpdate | undefined;
  private activeSlot: SystemSlot;
  private activeGeneration: number;
  private readonly now: () => number;

  constructor(private readonly options: {
    readonly deviceId: string;
    readonly hardwareId: string;
    readonly activeSlot: SystemSlot;
    readonly activeGeneration: number;
    readonly keyResolver: (keyId: string) => SigningKey | undefined;
    readonly now?: () => number;
  }) {
    if (options.deviceId.length === 0 || options.hardwareId.length === 0 ||
        !Number.isSafeInteger(options.activeGeneration) || options.activeGeneration < 1) {
      throw new Error('SYSTEM_UPDATER_OPTIONS_INVALID');
    }
    this.activeSlot = options.activeSlot;
    this.activeGeneration = options.activeGeneration;
    this.now = options.now ?? Date.now;
  }

  stage(
    manifest: SignedSystemImageManifest,
    input: { readonly writtenSlot: SystemSlot; readonly verifiedImageDigest: string },
  ): SystemUpdateReceipt {
    const at = this.now();
    const expectedSlot: SystemSlot = this.activeSlot === 'A' ? 'B' : 'A';
    if (!verifySystemImageManifest(manifest, this.options.keyResolver) ||
        manifest.payload.issuedAtEpochMs > at || manifest.payload.expiresAtEpochMs <= at ||
        manifest.payload.generation <= this.activeGeneration ||
        !manifest.payload.supportedHardwareIds.includes(this.options.hardwareId) ||
        input.writtenSlot !== expectedSlot ||
        input.verifiedImageDigest !== manifest.payload.imageDigest) {
      return this.receipt(manifest, expectedSlot, 'SYSTEM_UPDATE_STAGE_REJECTED', at);
    }
    this.staged = {
      manifest,
      targetSlot: expectedSlot,
      stagedImageDigest: input.verifiedImageDigest,
    };
    this.state = 'STAGED';
    return this.receipt(manifest, expectedSlot, 'SYSTEM_UPDATE_STAGED', at);
  }

  requestBoot(): SystemUpdateReceipt {
    const staged = this.requireStaged('STAGED');
    const at = this.now();
    staged.bootDeadlineEpochMs = at + staged.manifest.payload.healthConfirmationTimeoutMs;
    this.state = 'BOOT_PENDING';
    return this.receipt(staged.manifest, staged.targetSlot, 'SYSTEM_UPDATE_BOOT_REQUESTED', at);
  }

  recordBoot(input: { readonly bootedSlot: SystemSlot; readonly bootDigest: string }): SystemUpdateReceipt {
    const staged = this.requireStaged('BOOT_PENDING');
    const at = this.now();
    if (staged.bootDeadlineEpochMs === undefined || at >= staged.bootDeadlineEpochMs ||
        input.bootedSlot !== staged.targetSlot ||
        input.bootDigest !== staged.manifest.payload.bootDigest) {
      return this.rollbackInternal(staged, 'SYSTEM_UPDATE_BOOT_VERIFICATION_FAILED', at);
    }
    this.state = 'HEALTH_VALIDATION';
    return this.receipt(staged.manifest, staged.targetSlot, 'SYSTEM_UPDATE_BOOT_VERIFIED', at);
  }

  confirmHealth(snapshot: HealthSnapshot): SystemUpdateReceipt {
    const staged = this.requireStaged('HEALTH_VALIDATION');
    const at = this.now();
    if (staged.bootDeadlineEpochMs === undefined || at >= staged.bootDeadlineEpochMs ||
        snapshot.deviceId !== this.options.deviceId || !validateHealthSnapshot(snapshot) ||
        snapshot.action !== 'HEALTHY') {
      return this.rollbackInternal(staged, 'SYSTEM_UPDATE_HEALTH_REJECTED', at);
    }
    this.activeGeneration = staged.manifest.payload.generation;
    this.state = 'COMMITTED';
    const receipt = this.receipt(
      staged.manifest,
      staged.targetSlot,
      'SYSTEM_UPDATE_COMMITTED',
      at,
    );
    this.activeSlot = staged.targetSlot;
    this.staged = undefined;
    return receipt;
  }

  tick(): SystemUpdateReceipt | undefined {
    const staged = this.staged;
    if (!staged || staged.bootDeadlineEpochMs === undefined ||
        !['BOOT_PENDING', 'HEALTH_VALIDATION'].includes(this.state) ||
        this.now() < staged.bootDeadlineEpochMs) return undefined;
    return this.rollbackInternal(staged, 'SYSTEM_UPDATE_CONFIRMATION_TIMEOUT', this.now());
  }

  snapshot(): {
    readonly state: SystemUpdateState;
    readonly activeSlot: SystemSlot;
    readonly activeGeneration: number;
    readonly stagedReleaseId?: string;
  } {
    return {
      state: this.state,
      activeSlot: this.activeSlot,
      activeGeneration: this.activeGeneration,
      ...(this.staged ? { stagedReleaseId: this.staged.manifest.payload.releaseId } : {}),
    };
  }

  private requireStaged(expectedState: SystemUpdateState): StagedUpdate {
    if (this.state !== expectedState || !this.staged) {
      throw new Error('SYSTEM_UPDATE_STATE_INVALID');
    }
    return this.staged;
  }

  private rollbackInternal(
    staged: StagedUpdate,
    reasonCode: string,
    at: number,
  ): SystemUpdateReceipt {
    this.state = 'ROLLED_BACK';
    const receipt = this.receipt(staged.manifest, staged.targetSlot, reasonCode, at);
    this.staged = undefined;
    return receipt;
  }

  private receipt(
    manifest: SignedSystemImageManifest,
    targetSlot: SystemSlot,
    reasonCode: string,
    recordedAtEpochMs: number,
  ): SystemUpdateReceipt {
    const body = {
      deviceId: this.options.deviceId,
      releaseId: manifest.payload.releaseId,
      generation: manifest.payload.generation,
      previousSlot: this.activeSlot,
      targetSlot,
      state: this.state,
      reasonCode,
      recordedAtEpochMs,
    };
    return { ...body, receiptDigest: digest(body) };
  }
}
