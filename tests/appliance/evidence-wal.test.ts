import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EvidenceWal, verifyEvidenceRecords } from '@/lib/appliance/evidence-wal';

function fixture(maximumRecords = 4) {
  const keys = generateKeyPairSync('ed25519');
  const wal = new EvidenceWal({
    deviceId: 'device-1',
    signingKeyId: 'evidence-key-1',
    privateKey: keys.privateKey,
    maximumRecords,
    highWatermarkRatio: 0.75,
  });
  return { keys, wal };
}

function append(wal: EvidenceWal, index: number) {
  return wal.append({
    domain: index % 2 === 0 ? 'NETWORK_SECURITY' : 'MODEL_SECURITY',
    eventType: 'DECISION_ENFORCED',
    occurredAtEpochMs: 1_000 + index,
    policyBundleId: 'bundle-7',
    decisionId: 'decision-' + index,
    flowId: 'flow-1',
    payload: { action: index % 2 === 0 ? 'BLOCK' : 'ALLOW', index },
  });
}

describe('evidence WAL', () => {
  it('creates a signed, ordered hash chain', () => {
    const { keys, wal } = fixture();
    append(wal, 1);
    append(wal, 2);
    const batch = wal.createExportBatch(10);
    expect(batch?.recordCount).toBe(2);
    expect(verifyEvidenceRecords({
      records: batch?.records ?? [],
      expectedDeviceId: 'device-1',
      startingSequence: 1,
      previousRecordHash: 'GENESIS',
      keyResolver: (keyId) => keyId === 'evidence-key-1' ? keys.publicKey : undefined,
    })).toBe(true);
  });

  it('detects payload and chain tampering', () => {
    const { keys, wal } = fixture();
    const record = append(wal, 1);
    const tampered = {
      ...record,
      body: { ...record.body, payloadCanonicalJson: '{"action":"ALLOW"}' },
    };
    expect(verifyEvidenceRecords({
      records: [tampered], expectedDeviceId: 'device-1', startingSequence: 1,
      previousRecordHash: 'GENESIS', keyResolver: () => keys.publicKey,
    })).toBe(false);
  });

  it('releases capacity only after an exact export acknowledgement', () => {
    const { wal } = fixture(2);
    append(wal, 1);
    append(wal, 2);
    expect(() => append(wal, 3)).toThrow('EVIDENCE_CAPACITY_EXHAUSTED');
    const batch = wal.createExportBatch(2);
    expect(() => wal.acknowledgeExport({
      batchDigest: batch?.batchDigest ?? '',
      throughSequence: 2,
      throughRecordHash: 'sha256:wrong',
    })).toThrow('EVIDENCE_EXPORT_ACK_INVALID');
    wal.acknowledgeExport({
      batchDigest: batch?.batchDigest ?? '',
      throughSequence: batch?.lastSequence ?? 0,
      throughRecordHash: batch?.records.at(-1)?.recordHash ?? '',
    });
    expect(wal.compactAcknowledged()).toBe(2);
    expect(wal.status().protectedTrafficAdmissible).toBe(true);
  });

  it('raises the high-water signal before capacity exhaustion', () => {
    const { wal } = fixture(4);
    append(wal, 1);
    append(wal, 2);
    expect(wal.status().highWatermarkReached).toBe(false);
    append(wal, 3);
    expect(wal.status()).toMatchObject({
      highWatermarkReached: true,
      protectedTrafficAdmissible: true,
    });
  });

  it('preserves monotonic sequence and chain anchor after compaction', () => {
    const { keys, wal } = fixture(2);
    const first = append(wal, 1);
    const batch = wal.createExportBatch(1);
    wal.acknowledgeExport({
      batchDigest: batch?.batchDigest ?? '',
      throughSequence: 1,
      throughRecordHash: first.recordHash,
    });
    wal.compactAcknowledged();
    const second = append(wal, 2);
    expect(second.body.sequence).toBe(2);
    expect(second.body.previousRecordHash).toBe(first.recordHash);
    expect(verifyEvidenceRecords({
      records: [second], expectedDeviceId: 'device-1', startingSequence: 2,
      previousRecordHash: first.recordHash, keyResolver: () => keys.publicKey,
    })).toBe(true);
  });
});
