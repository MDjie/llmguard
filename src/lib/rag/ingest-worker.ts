import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readAcceptedTextArtifact } from '@/lib/artifacts';
import { buildLineageEdge } from '@/lib/data-protection/lineage';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { claimNextGuardJob, completeGuardJob, failGuardJob, updateGuardJobProgress } from '@/lib/guard-jobs';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { db } from '@/storage/database/shared/db';
import {
  artifacts,
  dataLineageEdges,
  ragChunks,
  ragSources,
} from '@/storage/database/shared/schema';
import { and, eq } from 'drizzle-orm';
import { scopePredicate } from '@/lib/tenancy';
import { ragContentHash, signRagProvenance } from './provenance';

const sourceMetadataSchema = z.object({
  sourceUri: z.string().max(2_000).default('unknown'),
  sourceType: z.string().min(1).max(64).default('document'),
  externalChunkId: z.string().min(1).max(256).optional(),
  trustLevel: z.number().int().min(0).max(100).default(0),
  classification: z.number().int().min(0).max(10).default(0),
  allowedPrincipals: z.array(z.string().max(100)).max(1_000).default([]),
  allowedRoles: z.array(z.string().max(100)).max(100).default([]),
}).passthrough();

export async function processNextRagIngestJob() {
  const job = await claimNextGuardJob(['rag_ingest']);
  if (!job) return null;
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  try {
    const [artifact] = await db.select().from(artifacts).where(and(
      eq(artifacts.id, job.artifactId), eq(artifacts.kind, 'RAG_CHUNK'),
      eq(artifacts.state, 'accepted'), scopePredicate(artifacts, scope),
    )).limit(1);
    if (!artifact) throw new Error('Accepted RAG artifact disappeared');
    const metadata = sourceMetadataSchema.parse(artifact.metadata ?? {});
    const text = await readAcceptedTextArtifact(
      scope,
      artifact.id,
      10 * 1_024 * 1_024,
      ['RAG_CHUNK'],
    );
    await updateGuardJobProgress(job, 'rag_ingest_guard', 40);
    const bundle = await loadVerifiedPolicyBundle(scope, job.bundleId);
    const decision = await createEngineForPolicyBundle(bundle).evaluate({
      contractVersion: '1.0',
      context: {
        traceId: `rag-ingest-${job.id}`, requestId: `rag-ingest-request-${job.id}`,
        tenantId: scope.tenantId, applicationId: scope.applicationId,
        direction: 'RAG_INGEST', absoluteDeadlineEpochMs: Date.now() + 60_000,
        policyBundleId: bundle.id,
      },
      content: { text },
    });
    const state = decision.action === 'BLOCK' ? 'quarantined' : 'accepted';
    const score = Math.round(Math.max(0, ...decision.observations.map((item) => item.score)) * 100);
    const records = await db.transaction(async (transaction) => {
      const [source] = await transaction.insert(ragSources).values({
        ...scope, artifactId: artifact.id,
        sourceUriHash: createHash('sha256').update(metadata.sourceUri).digest('hex'),
        sourceType: metadata.sourceType, trustLevel: metadata.trustLevel,
        classification: metadata.classification,
        acl: { allowedPrincipals: metadata.allowedPrincipals, allowedRoles: metadata.allowedRoles },
        state,
      }).onConflictDoUpdate({
        target: [ragSources.tenantId, ragSources.applicationId, ragSources.artifactId],
        set: { state, trustLevel: metadata.trustLevel, classification: metadata.classification },
      }).returning();
      const chunkId = metadata.externalChunkId ?? artifact.id;
      const contentHash = ragContentHash(text);
      const provenance = {
        ...scope, sourceId: source.id, chunkId, contentHash,
        trustLevel: metadata.trustLevel, classification: metadata.classification,
        allowedPrincipals: metadata.allowedPrincipals, allowedRoles: metadata.allowedRoles,
        state: state as 'accepted' | 'quarantined',
      };
      const signature = signRagProvenance(provenance);
      const [chunk] = await transaction.insert(ragChunks).values({
        ...scope, sourceId: source.id, artifactId: artifact.id, externalChunkId: chunkId,
        contentHash, provenanceSignature: signature, riskAction: decision.action,
        riskScore: score, state, metadata: { bundleId: bundle.id },
      }).onConflictDoUpdate({
        target: [ragChunks.tenantId, ragChunks.applicationId, ragChunks.externalChunkId],
        set: { contentHash, provenanceSignature: signature, riskAction: decision.action, riskScore: score, state },
      }).returning();
      await transaction.insert(dataLineageEdges).values([
        buildLineageEdge({
          tenantId: scope.tenantId,
          applicationId: scope.applicationId,
          sourceType: 'ARTIFACT',
          sourceId: artifact.id,
          targetType: 'RAG_SOURCE',
          targetId: source.id,
          operation: 'RAG_INGEST',
          processorId: 'guardllm-rag-ingest',
          processorVersion: '1.0',
          attributes: {
            sourceType: metadata.sourceType,
            state,
          },
        }),
        buildLineageEdge({
          tenantId: scope.tenantId,
          applicationId: scope.applicationId,
          sourceType: 'RAG_SOURCE',
          sourceId: source.id,
          targetType: 'RAG_CHUNK',
          targetId: chunk.id,
          operation: 'RAG_INGEST',
          processorId: 'guardllm-rag-ingest',
          processorVersion: '1.0',
          attributes: {
            externalChunkId: chunk.externalChunkId,
            contentHash,
            state,
          },
        }),
      ]).onConflictDoNothing();
      return { source, chunk, signature };
    });
    await completeGuardJob(job, {
      action: decision.action, state, sourceId: records.source.id,
      chunkId: records.chunk.externalChunkId, contentHash: records.chunk.contentHash,
      provenanceSignature: records.signature, decision,
    } as unknown as Record<string, unknown>);
    return { jobId: job.id, status: 'completed' };
  } catch (error) {
    await failGuardJob(job, error);
    return { jobId: job.id, status: job.attempt >= job.maxAttempts ? 'failed' : 'retrying' };
  }
}
