import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type { HealthAction } from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';

export type HaRole = 'STANDBY' | 'ACTIVE' | 'DRAINING' | 'FENCED';

export interface HaHeartbeat {
  readonly clusterId: string;
  readonly nodeId: string;
  readonly role: HaRole;
  readonly bundleGeneration: number;
  readonly sentAtEpochMs: number;
  readonly leaseTerm?: number;
  readonly fencingToken?: string;
}

export interface WitnessLease {
  readonly clusterId: string;
  readonly holderNodeId: string;
  readonly term: number;
  readonly fencingToken: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly leaseDigest: string;
}

export type HaTransitionReason =
  | 'PROMOTED_WITH_WITNESS'
  | 'PEER_ACTIVE'
  | 'BUNDLE_NOT_SYNCHRONIZED'
  | 'LOCAL_HEALTH_UNSAFE'
  | 'WITNESS_LEASE_UNAVAILABLE'
  | 'WITNESS_LEASE_RENEWED'
  | 'WITNESS_LEASE_LOST'
  | 'DEMOTED'
  | 'DRAIN_REQUESTED';

export interface HaTransitionReceipt {
  readonly clusterId: string;
  readonly nodeId: string;
  readonly previousRole: HaRole;
  readonly nextRole: HaRole;
  readonly reasonCode: HaTransitionReason;
  readonly bundleGeneration: number;
  readonly recordedAtEpochMs: number;
  readonly leaseTerm?: number;
  readonly fencingToken?: string;
  readonly receiptDigest: string;
}

interface LeaseBody {
  readonly clusterId: string;
  readonly holderNodeId: string;
  readonly term: number;
  readonly fencingToken: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function leaseWithDigest(body: LeaseBody): WitnessLease {
  return { ...body, leaseDigest: digest(body) };
}

/**
 * Deterministic witness reference used by the controller and conformance tests.
 * A production adapter must make grant/renew/revoke linearizable.
 */
export class WitnessLeaseAuthority {
  private readonly leases = new Map<string, WitnessLease>();
  private readonly terms = new Map<string, number>();

  constructor(private readonly authorityId: string) {
    if (authorityId.length === 0) throw new Error('WITNESS_AUTHORITY_ID_REQUIRED');
  }

  acquire(input: {
    readonly clusterId: string;
    readonly nodeId: string;
    readonly nowEpochMs: number;
    readonly ttlMs: number;
  }): WitnessLease | undefined {
    if (input.clusterId.length === 0 || input.nodeId.length === 0 ||
        !Number.isSafeInteger(input.nowEpochMs) || input.nowEpochMs < 1 ||
        !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
      throw new Error('WITNESS_LEASE_REQUEST_INVALID');
    }
    const current = this.leases.get(input.clusterId);
    if (current && current.expiresAtEpochMs > input.nowEpochMs &&
        current.holderNodeId !== input.nodeId) {
      return undefined;
    }
    if (current && current.expiresAtEpochMs > input.nowEpochMs &&
        current.holderNodeId === input.nodeId) {
      return this.renew({
        clusterId: input.clusterId,
        nodeId: input.nodeId,
        fencingToken: current.fencingToken,
        nowEpochMs: input.nowEpochMs,
        ttlMs: input.ttlMs,
      });
    }
    const term = (this.terms.get(input.clusterId) ?? 0) + 1;
    this.terms.set(input.clusterId, term);
    const fencingToken = digest({
      authorityId: this.authorityId,
      clusterId: input.clusterId,
      holderNodeId: input.nodeId,
      term,
      issuedAtEpochMs: input.nowEpochMs,
    });
    const lease = leaseWithDigest({
      clusterId: input.clusterId,
      holderNodeId: input.nodeId,
      term,
      fencingToken,
      issuedAtEpochMs: input.nowEpochMs,
      expiresAtEpochMs: input.nowEpochMs + input.ttlMs,
    });
    this.leases.set(input.clusterId, lease);
    return lease;
  }

  renew(input: {
    readonly clusterId: string;
    readonly nodeId: string;
    readonly fencingToken: string;
    readonly nowEpochMs: number;
    readonly ttlMs: number;
  }): WitnessLease | undefined {
    const current = this.leases.get(input.clusterId);
    if (!current || current.holderNodeId !== input.nodeId ||
        current.fencingToken !== input.fencingToken ||
        current.expiresAtEpochMs <= input.nowEpochMs || input.ttlMs < 1) {
      return undefined;
    }
    const renewed = leaseWithDigest({
      clusterId: current.clusterId,
      holderNodeId: current.holderNodeId,
      term: current.term,
      fencingToken: current.fencingToken,
      issuedAtEpochMs: current.issuedAtEpochMs,
      expiresAtEpochMs: input.nowEpochMs + input.ttlMs,
    });
    this.leases.set(input.clusterId, renewed);
    return renewed;
  }

  release(clusterId: string, nodeId: string, fencingToken: string): boolean {
    const current = this.leases.get(clusterId);
    if (!current || current.holderNodeId !== nodeId ||
        current.fencingToken !== fencingToken) return false;
    this.leases.delete(clusterId);
    return true;
  }

  isCurrent(lease: WitnessLease, nowEpochMs: number): boolean {
    const current = this.leases.get(lease.clusterId);
    return current !== undefined && current.holderNodeId === lease.holderNodeId &&
      current.term === lease.term && current.fencingToken === lease.fencingToken &&
      current.leaseDigest === lease.leaseDigest && current.expiresAtEpochMs > nowEpochMs;
  }
}

export interface HaControllerOptions {
  readonly clusterId: string;
  readonly nodeId: string;
  readonly peerNodeId: string;
  readonly peerTimeoutMs: number;
  readonly witness: WitnessLeaseAuthority;
  readonly now?: () => number;
}

export class HaController {
  private role: HaRole = 'STANDBY';
  private localHealth: HealthAction = 'HEALTHY';
  private bundleGeneration = 0;
  private peerHeartbeat: HaHeartbeat | undefined;
  private lease: WitnessLease | undefined;
  private readonly now: () => number;

  constructor(private readonly options: HaControllerOptions) {
    if (options.clusterId.length === 0 || options.nodeId.length === 0 ||
        options.peerNodeId.length === 0 || options.nodeId === options.peerNodeId ||
        !Number.isSafeInteger(options.peerTimeoutMs) || options.peerTimeoutMs < 1) {
      throw new Error('HA_CONTROLLER_OPTIONS_INVALID');
    }
    this.now = options.now ?? Date.now;
  }

  applySynchronizedBundle(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < this.bundleGeneration) {
      throw new Error('HA_BUNDLE_GENERATION_INVALID');
    }
    this.bundleGeneration = generation;
  }

  updateLocalHealth(action: HealthAction): HaTransitionReceipt | undefined {
    this.localHealth = action;
    if (this.role === 'ACTIVE' && ['DRAIN', 'ISOLATE', 'FAILOVER'].includes(action)) {
      return this.fence('LOCAL_HEALTH_UNSAFE');
    }
    return undefined;
  }

  observePeer(heartbeat: HaHeartbeat): void {
    if (heartbeat.clusterId !== this.options.clusterId ||
        heartbeat.nodeId !== this.options.peerNodeId ||
        !Number.isSafeInteger(heartbeat.sentAtEpochMs) || heartbeat.sentAtEpochMs < 1 ||
        heartbeat.sentAtEpochMs > this.now() ||
        (this.peerHeartbeat && heartbeat.sentAtEpochMs <= this.peerHeartbeat.sentAtEpochMs)) {
      throw new Error('HA_PEER_HEARTBEAT_INVALID');
    }
    this.peerHeartbeat = heartbeat;
  }

  promote(input: { readonly minimumBundleGeneration: number; readonly leaseTtlMs: number }): HaTransitionReceipt {
    const at = this.now();
    if (this.localHealth !== 'HEALTHY') return this.receipt(this.role, 'LOCAL_HEALTH_UNSAFE', at);
    if (this.bundleGeneration < input.minimumBundleGeneration) {
      return this.receipt(this.role, 'BUNDLE_NOT_SYNCHRONIZED', at);
    }
    if (this.peerHeartbeat && this.peerHeartbeat.role === 'ACTIVE' &&
        at - this.peerHeartbeat.sentAtEpochMs <= this.options.peerTimeoutMs) {
      return this.receipt(this.role, 'PEER_ACTIVE', at);
    }
    const lease = this.options.witness.acquire({
      clusterId: this.options.clusterId,
      nodeId: this.options.nodeId,
      nowEpochMs: at,
      ttlMs: input.leaseTtlMs,
    });
    if (!lease) return this.receipt(this.role, 'WITNESS_LEASE_UNAVAILABLE', at);
    const previous = this.role;
    this.lease = lease;
    this.role = 'ACTIVE';
    return this.receipt(previous, 'PROMOTED_WITH_WITNESS', at);
  }

  renewLease(ttlMs: number): HaTransitionReceipt {
    const at = this.now();
    if (this.role !== 'ACTIVE' || !this.lease) {
      return this.receipt(this.role, 'WITNESS_LEASE_LOST', at);
    }
    const renewed = this.options.witness.renew({
      clusterId: this.options.clusterId,
      nodeId: this.options.nodeId,
      fencingToken: this.lease.fencingToken,
      nowEpochMs: at,
      ttlMs,
    });
    if (!renewed) return this.fence('WITNESS_LEASE_LOST');
    this.lease = renewed;
    return this.receipt(this.role, 'WITNESS_LEASE_RENEWED', at);
  }

  drain(): HaTransitionReceipt {
    const previous = this.role;
    this.role = 'DRAINING';
    if (this.lease) {
      this.options.witness.release(
        this.options.clusterId,
        this.options.nodeId,
        this.lease.fencingToken,
      );
      this.lease = undefined;
    }
    return this.receipt(previous, 'DRAIN_REQUESTED', this.now());
  }

  demote(): HaTransitionReceipt {
    const previous = this.role;
    if (this.lease) {
      this.options.witness.release(
        this.options.clusterId,
        this.options.nodeId,
        this.lease.fencingToken,
      );
      this.lease = undefined;
    }
    this.role = 'STANDBY';
    return this.receipt(previous, 'DEMOTED', this.now());
  }

  tick(): HaTransitionReceipt | undefined {
    if (this.role === 'ACTIVE' && (!this.lease ||
        !this.options.witness.isCurrent(this.lease, this.now()))) {
      return this.fence('WITNESS_LEASE_LOST');
    }
    return undefined;
  }

  heartbeat(): HaHeartbeat {
    return {
      clusterId: this.options.clusterId,
      nodeId: this.options.nodeId,
      role: this.role,
      bundleGeneration: this.bundleGeneration,
      sentAtEpochMs: this.now(),
      ...(this.lease ? {
        leaseTerm: this.lease.term,
        fencingToken: this.lease.fencingToken,
      } : {}),
    };
  }

  canForwardProtectedTraffic(): boolean {
    return this.role === 'ACTIVE' && this.localHealth === 'HEALTHY' &&
      this.bundleGeneration > 0 && this.lease !== undefined &&
      this.options.witness.isCurrent(this.lease, this.now());
  }

  currentRole(): HaRole {
    return this.role;
  }

  private fence(reasonCode: 'LOCAL_HEALTH_UNSAFE' | 'WITNESS_LEASE_LOST'): HaTransitionReceipt {
    const previous = this.role;
    this.role = 'FENCED';
    this.lease = undefined;
    return this.receipt(previous, reasonCode, this.now());
  }

  private receipt(
    previousRole: HaRole,
    reasonCode: HaTransitionReason,
    recordedAtEpochMs: number,
  ): HaTransitionReceipt {
    const body = {
      clusterId: this.options.clusterId,
      nodeId: this.options.nodeId,
      previousRole,
      nextRole: this.role,
      reasonCode,
      bundleGeneration: this.bundleGeneration,
      recordedAtEpochMs,
      ...(this.lease ? {
        leaseTerm: this.lease.term,
        fencingToken: this.lease.fencingToken,
      } : {}),
    };
    return { ...body, receiptDigest: digest(body) };
  }
}
