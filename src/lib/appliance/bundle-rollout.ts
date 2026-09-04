import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type { BundleActivationReceipt } from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';

export type BundleRolloutState =
  | 'CANARY'
  | 'PROMOTION_READY'
  | 'FLEET'
  | 'COMPLETE'
  | 'COMPLETE_WITH_FAILURES'
  | 'ABORTED';

export interface BundleRolloutPlan {
  readonly rolloutId: string;
  readonly deviceGroupId: string;
  readonly bundleId: string;
  readonly generation: number;
  readonly targetDeviceIds: readonly string[];
  readonly canaryCount: number;
  readonly maximumFailures: number;
}

export interface BundleRolloutSnapshot {
  readonly rolloutId: string;
  readonly state: BundleRolloutState;
  readonly assignedDeviceIds: readonly string[];
  readonly activeDeviceIds: readonly string[];
  readonly failedDeviceIds: readonly string[];
  readonly pendingDeviceIds: readonly string[];
  readonly rollbackDeviceIds: readonly string[];
}

const RAW_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function receiptDigest(receipt: Omit<BundleActivationReceipt, 'receiptDigest'>): string {
  return createHash('sha256').update(canonicalJson(receipt)).digest('hex');
}

function validReceipt(receipt: BundleActivationReceipt): boolean {
  const { receiptDigest: actual, ...unsigned } = receipt;
  return RAW_SHA256_PATTERN.test(actual) && receiptDigest(unsigned) === actual;
}

function deterministicOrder(rolloutId: string, deviceIds: readonly string[]): readonly string[] {
  return [...deviceIds].sort((left, right) => {
    const leftHash = createHash('sha256').update(rolloutId + ':' + left).digest('hex');
    const rightHash = createHash('sha256').update(rolloutId + ':' + right).digest('hex');
    return leftHash.localeCompare(rightHash) || left.localeCompare(right);
  });
}

export class ApplianceBundleRollout {
  private state: BundleRolloutState = 'CANARY';
  private readonly orderedTargets: readonly string[];
  private readonly assigned = new Set<string>();
  private readonly receipts = new Map<string, BundleActivationReceipt>();

  constructor(private readonly plan: BundleRolloutPlan) {
    if (plan.rolloutId.length === 0 || plan.deviceGroupId.length === 0 ||
        plan.bundleId.length === 0 || !Number.isSafeInteger(plan.generation) ||
        plan.generation < 1 || plan.targetDeviceIds.length === 0 ||
        new Set(plan.targetDeviceIds).size !== plan.targetDeviceIds.length ||
        plan.targetDeviceIds.some((id) => id.length === 0) ||
        !Number.isSafeInteger(plan.canaryCount) || plan.canaryCount < 1 ||
        plan.canaryCount > plan.targetDeviceIds.length ||
        !Number.isSafeInteger(plan.maximumFailures) || plan.maximumFailures < 0 ||
        plan.maximumFailures >= plan.canaryCount) {
      throw new Error('BUNDLE_ROLLOUT_PLAN_INVALID');
    }
    this.orderedTargets = deterministicOrder(plan.rolloutId, plan.targetDeviceIds);
    for (const id of this.orderedTargets.slice(0, plan.canaryCount)) this.assigned.add(id);
  }

  recordReceipt(receipt: BundleActivationReceipt): BundleRolloutSnapshot {
    if (this.state === 'COMPLETE' || this.state === 'COMPLETE_WITH_FAILURES' ||
        this.state === 'ABORTED') {
      throw new Error('BUNDLE_ROLLOUT_TERMINAL');
    }
    if (!this.assigned.has(receipt.deviceId) || receipt.bundleId !== this.plan.bundleId ||
        receipt.generation !== this.plan.generation || !validReceipt(receipt)) {
      throw new Error('BUNDLE_ROLLOUT_RECEIPT_INVALID');
    }
    const existing = this.receipts.get(receipt.deviceId);
    if (existing) {
      if (existing.receiptDigest !== receipt.receiptDigest) {
        throw new Error('BUNDLE_ROLLOUT_RECEIPT_CONFLICT');
      }
      return this.snapshot();
    }
    if (receipt.status !== 'ACTIVE' && receipt.status !== 'REJECTED' &&
        receipt.status !== 'ROLLED_BACK') {
      throw new Error('BUNDLE_ROLLOUT_RECEIPT_NOT_FINAL');
    }
    this.receipts.set(receipt.deviceId, receipt);
    const failures = this.failedDeviceIds();
    if (failures.length > this.plan.maximumFailures) {
      this.state = 'ABORTED';
      return this.snapshot();
    }
    if (this.assigned.size === this.receipts.size) {
      this.state = this.state === 'CANARY'
        ? 'PROMOTION_READY'
        : failures.length === 0 ? 'COMPLETE' : 'COMPLETE_WITH_FAILURES';
    }
    return this.snapshot();
  }

  promoteCanary(): BundleRolloutSnapshot {
    if (this.state !== 'PROMOTION_READY') throw new Error('BUNDLE_ROLLOUT_NOT_PROMOTABLE');
    for (const id of this.orderedTargets) this.assigned.add(id);
    this.state = this.assigned.size === this.receipts.size ? 'COMPLETE' : 'FLEET';
    return this.snapshot();
  }

  abort(): BundleRolloutSnapshot {
    if (this.state === 'COMPLETE' || this.state === 'COMPLETE_WITH_FAILURES') {
      throw new Error('BUNDLE_ROLLOUT_ALREADY_COMPLETE');
    }
    this.state = 'ABORTED';
    return this.snapshot();
  }

  snapshot(): BundleRolloutSnapshot {
    const active = this.activeDeviceIds();
    const failed = this.failedDeviceIds();
    const assigned = this.orderedTargets.filter((id) => this.assigned.has(id));
    const pending = assigned.filter((id) => !this.receipts.has(id));
    return {
      rolloutId: this.plan.rolloutId,
      state: this.state,
      assignedDeviceIds: assigned,
      activeDeviceIds: active,
      failedDeviceIds: failed,
      pendingDeviceIds: pending,
      rollbackDeviceIds: this.state === 'ABORTED' ? active : [],
    };
  }

  private activeDeviceIds(): readonly string[] {
    return this.orderedTargets.filter((id) => this.receipts.get(id)?.status === 'ACTIVE');
  }

  private failedDeviceIds(): readonly string[] {
    return this.orderedTargets.filter((id) => {
      const status = this.receipts.get(id)?.status;
      return status === 'REJECTED' || status === 'ROLLED_BACK';
    });
  }
}
