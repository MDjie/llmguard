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
      expect(result.acceptedChunkIds).toEqual(['chunk-1']);
      expect(result.rejected).toEqual([{ chunkId: 'chunk-forged', code: 'RAG_CONTENT_HASH_MISMATCH' }]);
      expect(result.decisions.context.action).toBe('BLOCK');
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
});
