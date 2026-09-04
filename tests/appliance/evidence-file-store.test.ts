import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceFileStore } from '@/lib/appliance';
import { EvidenceWal } from '@/lib/appliance/evidence-wal';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture(maximumFileBytes = 100_000) {
  const directory = await mkdtemp(join(tmpdir(), 'guardllm-evidence-'));
  directories.push(directory);
  const keys = generateKeyPairSync('ed25519');
  const filePath = join(directory, 'evidence.wal');
  const store = new EvidenceFileStore({
    filePath, deviceId: 'device-1', maximumFileBytes,
    keyResolver: (keyId) => keyId === 'key-1' ? keys.publicKey : undefined,
  });
  const wal = new EvidenceWal({
    deviceId: 'device-1', signingKeyId: 'key-1', privateKey: keys.privateKey,
    maximumRecords: 10, highWatermarkRatio: 0.8,
  });
  await store.initialize();
  return { filePath, store, wal };
}

function record(wal: EvidenceWal, sequence: number) {
  return wal.append({
    domain: 'AUDIT', eventType: 'TEST', occurredAtEpochMs: 10_000 + sequence,
    policyBundleId: 'bundle-1', payload: { sequence },
  });
}

describe('durable evidence file store', () => {
  it('fsyncs records and recovers a verified chain after reopen', async () => {
    const { filePath, store, wal } = await fixture();
    await store.appendDurably(record(wal, 1));
    await store.appendDurably(record(wal, 2));
    const reopened = new EvidenceFileStore({
      filePath, deviceId: 'device-1', maximumFileBytes: 100_000,
      keyResolver: () => generateKeyPairSync('ed25519').publicKey,
    });
    await expect(reopened.recover()).rejects.toThrow('EVIDENCE_FILE_CHAIN_INVALID');
    const recovered = await store.recover();
    expect(recovered.records.map((item) => item.body.sequence)).toEqual([1, 2]);
  });

  it('rejects gaps and records from another chain', async () => {
    const { store, wal } = await fixture();
    const first = record(wal, 1);
    const second = record(wal, 2);
    await expect(store.appendDurably(second)).rejects.toThrow('EVIDENCE_FILE_APPEND_CHAIN_INVALID');
    await store.appendDurably(first);
  });

  it('detects a torn trailing write during recovery', async () => {
    const { filePath, store } = await fixture();
    await appendFile(filePath, '{"partial":true}');
    await expect(store.recover()).rejects.toThrow('EVIDENCE_FILE_TORN_WRITE');
  });

  it('fails closed when the configured evidence disk budget is exhausted', async () => {
    const { store, wal } = await fixture(1_024);
    const oversized = wal.append({
      domain: 'AUDIT', eventType: 'TEST', occurredAtEpochMs: 10_001,
      policyBundleId: 'bundle-1', payload: { data: 'x'.repeat(2_048) },
    });
    await expect(store.appendDurably(oversized))
      .rejects.toThrow('EVIDENCE_FILE_CAPACITY_EXHAUSTED');
  });
});
