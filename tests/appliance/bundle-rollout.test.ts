import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type { BundleActivationReceipt } from '../../packages/contracts-appliance/generated/typescript/appliance-v1';
import { ApplianceBundleRollout, type BundleRolloutPlan } from '@/lib/appliance/bundle-rollout';

const plan: BundleRolloutPlan = {
  rolloutId: 'rollout-1', deviceGroupId: 'group-1', bundleId: 'bundle-2', generation: 2,
  targetDeviceIds: ['device-a', 'device-b', 'device-c', 'device-d'],
  canaryCount: 2, maximumFailures: 0,
};

function receipt(
  deviceId: string,
  status: BundleActivationReceipt['status'],
): BundleActivationReceipt {
  const unsigned: Omit<BundleActivationReceipt, 'receiptDigest'> = {
    deviceId, bundleId: 'bundle-2', generation: 2, bundleDigest: 'sha256:' + 'a'.repeat(64),
    status, componentDigests: { guard: 'sha256:' + 'b'.repeat(64) },
    recordedAtEpochMs: 10_000,
  };
  return {
    ...unsigned,
    receiptDigest: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
  };
}

describe('appliance bundle canary rollout', () => {
  it('selects a deterministic canary independent of input order', () => {
    const first = new ApplianceBundleRollout(plan).snapshot().assignedDeviceIds;
    const second = new ApplianceBundleRollout({
      ...plan, targetDeviceIds: [...plan.targetDeviceIds].reverse(),
    }).snapshot().assignedDeviceIds;
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('promotes only after every canary returns an ACTIVE receipt', () => {
    const subject = new ApplianceBundleRollout(plan);
    const canaries = subject.snapshot().assignedDeviceIds;
    expect(subject.recordReceipt(receipt(canaries[0] ?? '', 'ACTIVE')).state).toBe('CANARY');
    expect(subject.recordReceipt(receipt(canaries[1] ?? '', 'ACTIVE')).state)
      .toBe('PROMOTION_READY');
    expect(subject.promoteCanary()).toMatchObject({ state: 'FLEET' });
  });

  it('aborts at the failure threshold and identifies active rollback targets', () => {
    const subject = new ApplianceBundleRollout(plan);
    const canaries = subject.snapshot().assignedDeviceIds;
    subject.recordReceipt(receipt(canaries[0] ?? '', 'ACTIVE'));
    const snapshot = subject.recordReceipt(receipt(canaries[1] ?? '', 'REJECTED'));
    expect(snapshot.state).toBe('ABORTED');
    expect(snapshot.rollbackDeviceIds).toEqual([canaries[0]]);
  });

  it('rejects unassigned, stale, tampered and non-final receipts', () => {
    const subject = new ApplianceBundleRollout(plan);
    expect(() => subject.recordReceipt(receipt('unknown', 'ACTIVE')))
      .toThrow('BUNDLE_ROLLOUT_RECEIPT_INVALID');
    const canary = subject.snapshot().assignedDeviceIds[0] ?? '';
    expect(() => subject.recordReceipt({ ...receipt(canary, 'ACTIVE'), generation: 1 }))
      .toThrow('BUNDLE_ROLLOUT_RECEIPT_INVALID');
    expect(() => subject.recordReceipt({ ...receipt(canary, 'ACTIVE'), receiptDigest: '0'.repeat(64) }))
      .toThrow('BUNDLE_ROLLOUT_RECEIPT_INVALID');
    expect(() => subject.recordReceipt(receipt(canary, 'PREPARED')))
      .toThrow('BUNDLE_ROLLOUT_RECEIPT_NOT_FINAL');
  });

  it('completes only after every fleet target is active', () => {
    const subject = new ApplianceBundleRollout({ ...plan, maximumFailures: 1 });
    const canaries = subject.snapshot().assignedDeviceIds;
    for (const id of canaries) subject.recordReceipt(receipt(id, 'ACTIVE'));
    const fleet = subject.promoteCanary().pendingDeviceIds;
    let snapshot = subject.snapshot();
    for (const id of fleet) snapshot = subject.recordReceipt(receipt(id, 'ACTIVE'));
    expect(snapshot).toMatchObject({ state: 'COMPLETE', pendingDeviceIds: [] });
  });

  it('distinguishes a tolerated partial fleet result from complete success', () => {
    const subject = new ApplianceBundleRollout({ ...plan, maximumFailures: 1 });
    const canaries = subject.snapshot().assignedDeviceIds;
    subject.recordReceipt(receipt(canaries[0] ?? '', 'ACTIVE'));
    subject.recordReceipt(receipt(canaries[1] ?? '', 'REJECTED'));
    const fleet = subject.promoteCanary().pendingDeviceIds;
    let snapshot = subject.snapshot();
    for (const id of fleet) snapshot = subject.recordReceipt(receipt(id, 'ACTIVE'));
    expect(snapshot).toMatchObject({
      state: 'COMPLETE_WITH_FAILURES',
      failedDeviceIds: [canaries[1]],
      pendingDeviceIds: [],
    });
  });
});
