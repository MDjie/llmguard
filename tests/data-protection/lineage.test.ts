import { describe, expect, it } from 'vitest';
import {
  buildDeletionProof,
  buildLineageEdge,
  lineageObjectIdDigest,
  verifyDeletionProof,
} from '../../src/lib/data-protection/lineage';

const proofEnvironment = {
  DELETION_PROOF_HMAC_KEY: 'd'.repeat(32),
  DELETION_PROOF_HMAC_KEY_ID: 'deletion-proof-v1',
};

describe('data lineage and deletion evidence', () => {
  it('produces deterministic, tamper-evident lineage hashes', () => {
    const input = {
      tenantId: 'tenant-a',
      applicationId: 'application-a',
      sourceType: 'ARTIFACT',
      sourceId: 'artifact-1',
      targetType: 'RAG_CHUNK',
      targetId: 'chunk-1',
      operation: 'RAG_INGEST',
      processorId: 'guardllm-rag-ingest',
      processorVersion: '1.0+build.2',
      attributes: { state: 'accepted', score: 0 },
      createdAt: new Date('2026-09-02T05:00:00.000Z'),
    } as const;
    const edge = buildLineageEdge(input);
    expect(edge.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(buildLineageEdge(input).evidenceHash).toBe(edge.evidenceHash);
    expect(buildLineageEdge({
      ...input,
      attributes: { state: 'quarantined', score: 100 },
    }).evidenceHash).not.toBe(edge.evidenceHash);
  });

  it('uses an order-independent digest for an exact object-id set', () => {
    expect(lineageObjectIdDigest(['b', 'a', 3]))
      .toBe(lineageObjectIdDigest([3, 'a', 'b']));
    expect(lineageObjectIdDigest(['a'])).not.toBe(lineageObjectIdDigest(['a', 'b']));
  });

  it('signs the cutoff, manifest, storage phases, completion time and key version', () => {
    const proof = buildDeletionProof({
      proofId: '11111111-1111-4111-8111-111111111111',
      cutoff: new Date('2026-08-26T00:00:00.000Z'),
      completedAt: new Date('2026-09-02T05:00:00.000Z'),
      manifest: [{
        objectType: 'SESSION',
        count: 2,
        idDigest: lineageObjectIdDigest(['session-1', 'session-2']),
      }],
      phases: {
        database: { state: 'COMPLETE', evidence: 'transaction-committed' },
        backup: { state: 'PENDING_EXTERNAL', evidence: 'expires-by-policy' },
      },
    }, proofEnvironment);
    expect(verifyDeletionProof(proof, proofEnvironment)).toBe(true);
    expect(verifyDeletionProof({
      ...proof,
      phases: { ...proof.phases, backup: { state: 'COMPLETE' } },
    }, proofEnvironment)).toBe(false);
    expect(verifyDeletionProof(proof, {
      ...proofEnvironment,
      DELETION_PROOF_HMAC_KEY: 'x'.repeat(32),
    })).toBe(false);
  });

  it('rejects empty proofs and unconfirmed database deletion', () => {
    expect(() => buildDeletionProof({
      cutoff: new Date(),
      manifest: [],
      phases: { database: { state: 'COMPLETE' } },
    }, proofEnvironment)).toThrow(/at least one/u);
    expect(() => buildDeletionProof({
      cutoff: new Date(),
      manifest: [{
        objectType: 'SESSION',
        count: 1,
        idDigest: lineageObjectIdDigest(['session-1']),
      }],
      phases: { database: { state: 'PENDING_EXTERNAL' } },
    }, proofEnvironment)).toThrow(/completed database/u);
  });
});
