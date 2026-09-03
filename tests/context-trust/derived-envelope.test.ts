import { describe, expect, it } from 'vitest';
import type { ContextEnvelope } from '@guardllm/contracts';
import { deriveContextEnvelope } from '../../src/lib/context-trust';

function parent(overrides: Partial<ContextEnvelope> = {}): ContextEnvelope {
  return {
    envelopeId: 'parent-1',
    tenantId: 'tenant-1',
    applicationId: 'app-1',
    sessionId: 'session-1',
    sourceType: 'USER',
    sourceId: 'user-1',
    trustLevel: 'CONTROLLED',
    instructionCapability: 'ALLOWED',
    sensitivityLabels: ['internal'],
    contentHash: 'a'.repeat(64),
    parentEnvelopeIds: [],
    policyVersion: '1',
    eventSeq: 1,
    contentStart: 0,
    contentEnd: 1,
    expiresAtEpochMs: 2_000,
    ...overrides,
  };
}

describe('derived context provenance', () => {
  it('inherits the most restrictive trust, capability, labels and expiry', () => {
    const derived = deriveContextEnvelope({
      content: 'summary',
      sourceType: 'MEMORY',
      sourceId: 'summary-1',
      parents: [
        parent(),
        parent({
          envelopeId: 'parent-2',
          sourceType: 'RAG',
          trustLevel: 'UNTRUSTED',
          instructionCapability: 'FORBIDDEN',
          sensitivityLabels: ['confidential'],
          expiresAtEpochMs: 1_000,
        }),
      ],
      riskLabels: ['prompt_injection'],
      eventSeq: 3,
      policyVersion: '2',
    });
    expect(derived.trustLevel).toBe('UNTRUSTED');
    expect(derived.instructionCapability).toBe('FORBIDDEN');
    expect(derived.sensitivityLabels).toEqual([
      'confidential',
      'internal',
      'risk:prompt_injection',
    ]);
    expect(derived.parentEnvelopeIds).toEqual(['parent-1', 'parent-2']);
    expect(derived.expiresAtEpochMs).toBe(1_000);
    expect(derived.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects derivation across tenant or application boundaries', () => {
    expect(() => deriveContextEnvelope({
      content: 'summary',
      sourceType: 'AGENT',
      sourceId: 'summary-1',
      parents: [parent(), parent({ envelopeId: 'parent-2', tenantId: 'tenant-2' })],
      eventSeq: 3,
      policyVersion: '2',
    })).toThrow('DERIVED_CONTEXT_SCOPE_MISMATCH');
  });
});
