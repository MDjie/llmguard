import { describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_VERSION,
  AUDIT_GENESIS_HASH,
  auditPartitionKey,
  computeAuditEventHash,
  verifyAuditChain,
  verifyAuditChainWithKeyResolver,
  type AuditChainEntry,
} from '../../src/lib/audit/chain';
import { resolveAuditChainConfiguration } from '../../src/lib/audit/repository';

const key = 'audit-test-key-that-is-longer-than-thirty-two-bytes';

function entry(sequence: number, previousHash: string, event = 'policy.read'): AuditChainEntry {
  const unsigned = {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    event,
    outcome: 'ALLOWED',
    status: 200,
    requestId: `request-${sequence}`,
    traceId: `trace-${sequence}`,
    method: 'GET',
    path: '/api/policies',
    latencyMs: sequence,
    principalId: 'auditor',
    tenantId: 'tenant-a',
    applicationId: 'app-a',
    createdAt: `2026-09-02T00:00:0${sequence}.000Z`,
    partitionKey: auditPartitionKey('tenant-a', 'app-a'),
    chainSequence: sequence,
    previousHash,
    hashKeyId: 'test-v1',
    chainVersion: AUDIT_CHAIN_VERSION,
  };
  return { ...unsigned, eventHash: computeAuditEventHash(unsigned, key) };
}

describe('UPG-AUD-001 tamper-evident audit chain', () => {
  it('verifies a contiguous partition chain', () => {
    const first = entry(1, AUDIT_GENESIS_HASH);
    const second = entry(2, first.eventHash);
    expect(verifyAuditChain([first, second], key)).toEqual({
      valid: true,
      checked: 2,
      headHash: second.eventHash,
    });
  });

  it('detects payload mutation, deletion and reordering', () => {
    const first = entry(1, AUDIT_GENESIS_HASH);
    const second = entry(2, first.eventHash);
    expect(verifyAuditChain([{ ...first, path: '/api/secret' }, second], key).error).toBe('EVENT_HASH_MISMATCH');
    expect(verifyAuditChain([second], key).error).toBe('SEQUENCE_GAP');
    expect(verifyAuditChain([second, first], key).error).toBe('SEQUENCE_GAP');
  });

  it('requires a strong configured key and validates the key id', () => {
    expect(() => resolveAuditChainConfiguration({ AUDIT_CHAIN_KEY: 'short' })).toThrow(/32 bytes/);
    expect(resolveAuditChainConfiguration({ AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEY_ID: 'hsm-2026.09' }))
      .toEqual({ key, keyId: 'hsm-2026.09' });
    expect(() => resolveAuditChainConfiguration({ AUDIT_CHAIN_KEY: key, AUDIT_CHAIN_KEY_ID: 'bad id' }))
      .toThrow(/invalid/);
  });

  it('supports key rotation and rejects an unavailable historical key', () => {
    const first = entry(1, AUDIT_GENESIS_HASH);
    const rotatedKey = 'rotated-audit-test-key-that-is-longer-than-thirty-two';
    const unsignedSecond = {
      ...entry(2, first.eventHash),
      hashKeyId: 'test-v2',
    };
    const second = { ...unsignedSecond, eventHash: computeAuditEventHash(unsignedSecond, rotatedKey) };
    expect(verifyAuditChainWithKeyResolver(
      [first, second],
      (keyId) => ({ 'test-v1': key, 'test-v2': rotatedKey })[keyId],
    ).valid).toBe(true);
    expect(verifyAuditChainWithKeyResolver([first, second], (keyId) => keyId === 'test-v1' ? key : undefined).error)
      .toBe('KEY_UNAVAILABLE');
  });
});
