import { describe, expect, it } from 'vitest';
import { HaController, WitnessLeaseAuthority } from '@/lib/appliance/ha-controller';

function controllers(clock: { value: number }) {
  const witness = new WitnessLeaseAuthority('witness-1');
  const common = { clusterId: 'cluster-1', peerTimeoutMs: 100, witness, now: () => clock.value };
  const a = new HaController({ ...common, nodeId: 'node-a', peerNodeId: 'node-b' });
  const b = new HaController({ ...common, nodeId: 'node-b', peerNodeId: 'node-a' });
  a.applySynchronizedBundle(7);
  b.applySynchronizedBundle(7);
  return { a, b };
}

describe('HA controller', () => {
  it('requires a synchronized bundle and healthy node before promotion', () => {
    const clock = { value: 1_000 };
    const witness = new WitnessLeaseAuthority('witness-1');
    const node = new HaController({
      clusterId: 'c', nodeId: 'a', peerNodeId: 'b', peerTimeoutMs: 100,
      witness, now: () => clock.value,
    });
    expect(node.promote({ minimumBundleGeneration: 1, leaseTtlMs: 50 }).reasonCode)
      .toBe('BUNDLE_NOT_SYNCHRONIZED');
    node.applySynchronizedBundle(1);
    node.updateLocalHealth('DEGRADE');
    expect(node.promote({ minimumBundleGeneration: 1, leaseTtlMs: 50 }).reasonCode)
      .toBe('LOCAL_HEALTH_UNSAFE');
  });

  it('allows only one active holder through a shared witness', () => {
    const clock = { value: 1_000 };
    const { a, b } = controllers(clock);
    expect(a.promote({ minimumBundleGeneration: 7, leaseTtlMs: 50 }).nextRole).toBe('ACTIVE');
    expect(a.canForwardProtectedTraffic()).toBe(true);
    expect(b.promote({ minimumBundleGeneration: 7, leaseTtlMs: 50 }).reasonCode)
      .toBe('WITNESS_LEASE_UNAVAILABLE');
    expect(b.canForwardProtectedTraffic()).toBe(false);
  });

  it('rejects promotion while a fresh peer declares active', () => {
    const clock = { value: 1_000 };
    const { a, b } = controllers(clock);
    a.promote({ minimumBundleGeneration: 7, leaseTtlMs: 50 });
    b.observePeer(a.heartbeat());
    expect(b.promote({ minimumBundleGeneration: 7, leaseTtlMs: 50 }).reasonCode)
      .toBe('PEER_ACTIVE');
  });

  it('fences an active node when its lease expires', () => {
    const clock = { value: 1_000 };
    const { a } = controllers(clock);
    a.promote({ minimumBundleGeneration: 7, leaseTtlMs: 50 });
    clock.value = 1_051;
    expect(a.tick()?.reasonCode).toBe('WITNESS_LEASE_LOST');
    expect(a.currentRole()).toBe('FENCED');
    expect(a.canForwardProtectedTraffic()).toBe(false);
  });

  it('hands off after explicit demotion and uses a higher witness term', () => {
    const clock = { value: 1_000 };
    const { a, b } = controllers(clock);
    const first = a.promote({ minimumBundleGeneration: 7, leaseTtlMs: 50 });
    a.demote();
    const second = b.promote({ minimumBundleGeneration: 7, leaseTtlMs: 50 });
    expect(second.nextRole).toBe('ACTIVE');
    expect(second.leaseTerm).toBeGreaterThan(first.leaseTerm ?? 0);
  });
});
