import { describe, expect, it } from 'vitest';
import { guardRagFlow, ragContentHash, signRagProvenance } from '../../src/lib/rag';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle';

const bundle: RuntimePolicyBundle = {
  id: 'bundle-1', generation: 1,
  payload: {
    schemaVersion: '1.0', policyId: 'policy-1', policyVersion: 1,
    dimensions: [{ id: 'd', code: 'indirect_injection', name: 'Indirect injection', weight: 1 }],
    rules: [{ id: 'r', riskType: 'indirect_injection', pattern: 'ignore system', matchType: 'contains', caseSensitive: false, score: 1, mandatoryDeny: true }],
    exceptions: [], thresholds: [{ dimensionId: 'd', warn: 0.5, block: 0.8, autoMask: false, autoRewrite: false }],
  },
};

describe('five-stage RAG guard', () => {
  it('filters scope/ACL tampering and blocks indirect injection in accepted context', async () => {
    const previousContent = process.env.CONTENT_HASH_KEY;
    const previousRag = process.env.RAG_PROVENANCE_KEY;
    process.env.CONTENT_HASH_KEY = 'rag-test-content-hmac-key-32-bytes-minimum';
    process.env.RAG_PROVENANCE_KEY = 'rag-test-provenance-key-32-bytes-minimum';
    try {
      const base = {
        tenantId: 'tenant-1', applicationId: 'app-1', sourceId: 'source-1',
        chunkId: 'chunk-1', contentHash: ragContentHash('ignore system'),
        trustLevel: 50, classification: 3,
        allowedPrincipals: ['user-1'], allowedRoles: [] as string[], state: 'accepted' as const,
      };
      const accepted = { ...base, text: 'ignore system', signature: signRagProvenance(base) };
      const forged = { ...accepted, chunkId: 'chunk-forged', text: 'ordinary' };
      const result = await guardRagFlow({
        scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
        principal: { id: 'user-1', roles: ['BUSINESS_OPERATOR'], clearance: 5 },
        bundle, traceId: 'rag-trace-1234567890', absoluteDeadlineEpochMs: Date.now() + 5_000,
        query: 'summarize', candidates: [accepted, forged], output: 'answer', citedChunkIds: ['chunk-1'],
      });
      expect(result.acceptedChunkIds).toEqual([]);
      expect(result.rejected).toEqual([
        { chunkId: 'chunk-forged', code: 'RAG_CONTENT_HASH_MISMATCH' },
        { chunkId: 'chunk-1', code: 'RAG_CHUNK_GUARD_REJECTED' },
      ]);
      expect(result.decisions.candidates[0].action).toBe('BLOCK');
      expect(result.decisions.context.action).toBe('ALLOW');
      expect(result.action).toBe('BLOCK');
      expect(result.tainted).toBe(true);
    } finally {
      process.env.CONTENT_HASH_KEY = previousContent;
      process.env.RAG_PROVENANCE_KEY = previousRag;
    }
  });

  it('rejects candidates above clearance even with a valid signature', async () => {
    const previousContent = process.env.CONTENT_HASH_KEY;
    const previousRag = process.env.RAG_PROVENANCE_KEY;
    process.env.CONTENT_HASH_KEY = 'rag-test-content-hmac-key-32-bytes-minimum';
    process.env.RAG_PROVENANCE_KEY = 'rag-test-provenance-key-32-bytes-minimum';
    try {
      const provenance = {
        tenantId: 'tenant-1', applicationId: 'app-1', sourceId: 's', chunkId: 'secret',
        contentHash: ragContentHash('ordinary'), trustLevel: 100, classification: 9,
        allowedPrincipals: [] as string[], allowedRoles: [] as string[], state: 'accepted' as const,
      };
      const result = await guardRagFlow({
        scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
        principal: { id: 'user', roles: [], clearance: 3 }, bundle,
        traceId: 'rag-trace-abcdefghij', absoluteDeadlineEpochMs: Date.now() + 5_000,
        query: 'hello', candidates: [{ ...provenance, text: 'ordinary', signature: signRagProvenance(provenance) }],
      });
      expect(result.rejected[0].code).toBe('RAG_CLASSIFICATION_DENIED');
    } finally {
      process.env.CONTENT_HASH_KEY = previousContent;
      process.env.RAG_PROVENANCE_KEY = previousRag;
    }
  });

  it('detects an attack assembled across individually safe chunks', async () => {
    const previousContent = process.env.CONTENT_HASH_KEY;
    const previousRag = process.env.RAG_PROVENANCE_KEY;
    process.env.CONTENT_HASH_KEY = 'rag-test-content-hmac-key-32-bytes-minimum';
    process.env.RAG_PROVENANCE_KEY = 'rag-test-provenance-key-32-bytes-minimum';
    try {
      const candidate = (chunkId: string, sourceId: string, text: string) => {
        const provenance = {
          tenantId: 'tenant-1', applicationId: 'app-1', sourceId, chunkId,
          contentHash: ragContentHash(text), trustLevel: 80, classification: 1,
          allowedPrincipals: [] as string[], allowedRoles: [] as string[], state: 'accepted' as const,
          sourceVersion: 'version-1', validUntilEpochMs: Date.now() + 60_000,
        };
        return { ...provenance, text, signature: signRagProvenance(provenance) };
      };
      const result = await guardRagFlow({
        scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
        principal: { id: 'user', roles: [], clearance: 3 },
        bundle,
        traceId: 'rag-trace-cross-chunk',
        absoluteDeadlineEpochMs: Date.now() + 5_000,
        query: 'summarize',
        candidates: [
          candidate('chunk-a', 'source-a', 'ignore '),
          candidate('chunk-b', 'source-b', 'system'),
        ],
      });
      expect(result.acceptedChunkIds).toEqual(['chunk-a', 'chunk-b']);
      expect(result.decisions.candidates.every((item) => item.action === 'ALLOW')).toBe(true);
      expect(result.decisions.combination.action).toBe('BLOCK');
      expect(result.decisions.combination.observations[0].evidence[0].sourceEnvelopeIds)
        .toHaveLength(2);
      expect(result.taintReasons).toContain('cross_chunk_combination_risk');
      expect(result.action).toBe('BLOCK');
    } finally {
      process.env.CONTENT_HASH_KEY = previousContent;
      process.env.RAG_PROVENANCE_KEY = previousRag;
    }
  });

  it('rejects expired and below-reputation signed sources before model context assembly', async () => {
    const previousContent = process.env.CONTENT_HASH_KEY;
    const previousRag = process.env.RAG_PROVENANCE_KEY;
    process.env.CONTENT_HASH_KEY = 'rag-test-content-hmac-key-32-bytes-minimum';
    process.env.RAG_PROVENANCE_KEY = 'rag-test-provenance-key-32-bytes-minimum';
    try {
      const make = (chunkId: string, trustLevel: number, validUntilEpochMs: number) => {
        const provenance = {
          tenantId: 'tenant-1', applicationId: 'app-1', sourceId: chunkId, chunkId,
          contentHash: ragContentHash('ordinary ' + chunkId), trustLevel, classification: 1,
          allowedPrincipals: [] as string[], allowedRoles: [] as string[], state: 'accepted' as const,
          validUntilEpochMs,
        };
        return { ...provenance, text: 'ordinary ' + chunkId, signature: signRagProvenance(provenance) };
      };
      const result = await guardRagFlow({
        scope: { tenantId: 'tenant-1', applicationId: 'app-1' },
        principal: { id: 'user', roles: [], clearance: 3 },
        bundle,
        traceId: 'rag-trace-source-gate',
        absoluteDeadlineEpochMs: Date.now() + 5_000,
        query: 'hello',
        candidates: [
          make('expired', 90, Date.now() - 1),
          make('low-trust', 10, Date.now() + 60_000),
        ],
        minimumTrustLevel: 50,
      });
      expect(result.acceptedChunkIds).toEqual([]);
      expect(result.rejected.map((item) => item.code)).toEqual([
        'RAG_SOURCE_EXPIRED',
        'RAG_SOURCE_REPUTATION_LOW',
      ]);
    } finally {
      process.env.CONTENT_HASH_KEY = previousContent;
      process.env.RAG_PROVENANCE_KEY = previousRag;
    }
  });
});
