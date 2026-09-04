import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createHealthSnapshot,
  signSystemImageManifest,
  verifySystemImageManifest,
  type SystemImageManifest,
} from '@/lib/appliance';
import { AbSystemUpdater } from '@/lib/appliance/system-update';

const clock = { value: 10_000 };
const keys = generateKeyPairSync('ed25519');
const d = (value: string) => 'sha256:' + value.repeat(64);

const payload: SystemImageManifest = {
  schemaVersion: '1.0', releaseId: 'release-2', version: '2.0.0', generation: 2,
  imageDigest: d('a'), bootDigest: d('b'), componentDigests: { rootfs: d('c') },
  supportedHardwareIds: ['hardware-1'], issuedAtEpochMs: 9_000, expiresAtEpochMs: 20_000,
  healthConfirmationTimeoutMs: 500,
};

function signed(overrides: Partial<SystemImageManifest> = {}) {
  return signSystemImageManifest({ ...payload, ...overrides }, {
    signingKeyId: 'release-key-1', privateKey: keys.privateKey,
  });
}

function updater() {
  return new AbSystemUpdater({
    deviceId: 'device-1', hardwareId: 'hardware-1', activeSlot: 'A', activeGeneration: 1,
    keyResolver: (keyId) => keyId === 'release-key-1' ? keys.publicKey : undefined,
    now: () => clock.value,
  });
}

function health(action: 'HEALTHY' | 'FAILOVER' = 'HEALTHY') {
  return createHealthSnapshot({
    deviceId: 'device-1', generation: 1, capturedAtEpochMs: clock.value,
    components: [{ componentId: 'system', action,
      reasonCodes: [] }],
  });
}

describe('signed A/B system update', () => {
  it('verifies signatures and detects manifest tampering', () => {
    const manifest = signed();
    expect(verifySystemImageManifest(manifest, () => keys.publicKey)).toBe(true);
    expect(verifySystemImageManifest({
      ...manifest, payload: { ...manifest.payload, version: 'tampered' },
    }, () => keys.publicKey)).toBe(false);
  });

  it('stages only the verified image on the inactive slot', () => {
    clock.value = 10_000;
    expect(updater().stage(signed(), { writtenSlot: 'A', verifiedImageDigest: d('a') }))
      .toMatchObject({ state: 'IDLE', reasonCode: 'SYSTEM_UPDATE_STAGE_REJECTED' });
    expect(updater().stage(signed(), { writtenSlot: 'B', verifiedImageDigest: d('f') }))
      .toMatchObject({ state: 'IDLE', reasonCode: 'SYSTEM_UPDATE_STAGE_REJECTED' });
    expect(updater().stage(signed(), { writtenSlot: 'B', verifiedImageDigest: d('a') }))
      .toMatchObject({ state: 'STAGED', targetSlot: 'B' });
  });

  it('commits only after verified boot and healthy device evidence', () => {
    clock.value = 10_000;
    const subject = updater();
    subject.stage(signed(), { writtenSlot: 'B', verifiedImageDigest: d('a') });
    subject.requestBoot();
    subject.recordBoot({ bootedSlot: 'B', bootDigest: d('b') });
    expect(subject.confirmHealth(health())).toMatchObject({
      state: 'COMMITTED', reasonCode: 'SYSTEM_UPDATE_COMMITTED', previousSlot: 'A', targetSlot: 'B',
    });
    expect(subject.snapshot()).toEqual({ state: 'COMMITTED', activeSlot: 'B', activeGeneration: 2 });
  });

  it('rolls back on wrong boot identity or unsafe health', () => {
    clock.value = 10_000;
    const wrongBoot = updater();
    wrongBoot.stage(signed(), { writtenSlot: 'B', verifiedImageDigest: d('a') });
    wrongBoot.requestBoot();
    expect(wrongBoot.recordBoot({ bootedSlot: 'B', bootDigest: d('f') }))
      .toMatchObject({ state: 'ROLLED_BACK', reasonCode: 'SYSTEM_UPDATE_BOOT_VERIFICATION_FAILED' });
    expect(wrongBoot.snapshot().activeSlot).toBe('A');

    const unsafe = updater();
    unsafe.stage(signed(), { writtenSlot: 'B', verifiedImageDigest: d('a') });
    unsafe.requestBoot();
    unsafe.recordBoot({ bootedSlot: 'B', bootDigest: d('b') });
    expect(unsafe.confirmHealth(health('FAILOVER'))).toMatchObject({ state: 'ROLLED_BACK' });
  });

  it('automatically rolls back when boot confirmation times out', () => {
    clock.value = 10_000;
    const subject = updater();
    subject.stage(signed(), { writtenSlot: 'B', verifiedImageDigest: d('a') });
    subject.requestBoot();
    clock.value = 10_501;
    expect(subject.tick()).toMatchObject({
      state: 'ROLLED_BACK', reasonCode: 'SYSTEM_UPDATE_CONFIRMATION_TIMEOUT',
    });
    expect(subject.snapshot()).toMatchObject({ activeSlot: 'A', activeGeneration: 1 });
  });
});
