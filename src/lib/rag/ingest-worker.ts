import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readAcceptedTextArtifact } from '@/lib/artifacts';
import { buildLineageEdge } from '@/lib/data-protection/lineage';
import { createEngineForPolicyBundle } from '@/lib/guard-engine-v2';
import { claimNextGuardJob, completeGuardJobWithEffects, failGuardJob, updateGuardJobProgress, monitorGuardJobCancellation, isGuardJobCancellationError } from '@/lib/guard-jobs';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { db } from '@/storage/database/shared/db';
import {
  artifacts,
  dataLineageEdges,
  ragChunks,
  ragSources,
} from '@/storage/database/shared/schema';
import { and, eq, sql } from 'drizzle-orm';
import { scopePredicate } from '@/lib/tenancy';
import { ragContentHash, signRagProvenance } from './provenance';
import {assertRagIngestBinding} from './ingest-binding';
import {ragIngestContent,ragIngestDisposition} from './ingest-policy';
import {validateMediaRagLineage} from './media-lineage';

const sourceMetadataSchema = z.object({
  sourceUri: z.string().max(2_000).default('unknown'),
  sourceType: z.string().min(1).max(64).default('document'),
  externalChunkId: z.string().min(1).max(256).optional(),
  trustLevel: z.number().int().min(0).max(100).default(0),
  classification: z.number().int().min(0).max(10).default(0),
  allowedPrincipals: z.array(z.string().max(100)).max(1_000).default([]),
  allowedRoles: z.array(z.string().max(100)).max(100).default([]),
  sourceVersion: z.string().min(1).max(128).optional(),
  validUntilEpochMs: z.number().int().positive().optional(),
}).passthrough();

export async function processNextRagIngestJob() {
  const job = await claimNextGuardJob(['rag_ingest']);
  if (!job) return null;
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  const monitor=monitorGuardJobCancellation(job),deadline=Date.now()+120000;
  const signal=AbortSignal.any([monitor.signal,AbortSignal.timeout(120000)]);
  try {
    signal.throwIfAborted();
    const [artifact] = await db.select().from(artifacts).where(and(
      eq(artifacts.id, job.artifactId),eq(artifacts.ownerId,job.ownerId), eq(artifacts.kind, 'RAG_CHUNK'),
      eq(artifacts.state, 'accepted'), scopePredicate(artifacts, scope),
    )).limit(1);
    if (!artifact) throw new Error('RAG_SOURCE_UNAVAILABLE');
    assertRagIngestBinding(job.executionBinding,artifact);
    const metadata = sourceMetadataSchema.parse(artifact.metadata ?? {});
    if (metadata.mediaLineage !== undefined) await validateMediaRagLineage(db, scope, job.ownerId, metadata.mediaLineage);
    const text = await readAcceptedTextArtifact(
      scope,
      artifact.id,
      10 * 1_024 * 1_024,
      ['RAG_CHUNK'],signal,
    );
    await updateGuardJobProgress(job, 'rag_ingest_guard', 40);
    const bundle = await loadVerifiedPolicyBundle(scope, job.bundleId);
    const context={
      traceId:`rag-ingest-${job.id}`,requestId:`rag-ingest-request-${job.id}`,
      ...scope,subjectId:job.ownerId,direction:'RAG_INGEST' as const,
      absoluteDeadlineEpochMs:deadline,policyBundleId:bundle.id,taskPurpose:'Inspect untrusted source material before indexing for retrieval',
    };
    const decision=await createEngineForPolicyBundle(bundle).evaluate({contractVersion:'1.0',context,content:ragIngestContent(text,artifact.id,context)},signal);
    signal.throwIfAborted();
    const state=ragIngestDisposition(decision);
    const score = Math.round(Math.max(0, ...decision.observations.map((item) => item.score)) * 100);
    await completeGuardJobWithEffects(job,async (transaction) => {
      signal.throwIfAborted();
      const [current]=await transaction.select().from(artifacts).where(and(scopePredicate(artifacts,scope),eq(artifacts.id,artifact.id),eq(artifacts.ownerId,job.ownerId))).for('share');
      if(!current)throw new Error('RAG_SOURCE_UNAVAILABLE');
      assertRagIngestBinding(job.executionBinding,current);
      if (metadata.mediaLineage !== undefined) await validateMediaRagLineage(transaction, scope, job.ownerId, metadata.mediaLineage);
      const chunkId = metadata.externalChunkId ?? artifact.id;
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId+':'+scope.applicationId+':rag-chunk:'+chunkId}))`);
      const [previousOwner]=await transaction.select({ownerId:artifacts.ownerId}).from(ragChunks).innerJoin(artifacts,and(eq(artifacts.id,ragChunks.artifactId),scopePredicate(artifacts,scope))).where(and(scopePredicate(ragChunks,scope),eq(ragChunks.externalChunkId,chunkId))).limit(1);
      if(previousOwner&&previousOwner.ownerId!==job.ownerId)throw new Error('RAG_CHUNK_OWNER_CONFLICT');
      const [source] = await transaction.insert(ragSources).values({
        ...scope, artifactId: artifact.id,
        sourceUriHash: createHash('sha256').update(metadata.sourceUri).digest('hex'),
        sourceType: metadata.sourceType, trustLevel: metadata.trustLevel,
        classification: metadata.classification,
        acl: { allowedPrincipals: metadata.allowedPrincipals, allowedRoles: metadata.allowedRoles },
        state,
      }).onConflictDoUpdate({
        target: [ragSources.tenantId, ragSources.applicationId, ragSources.artifactId],
        set: { state, sourceUriHash: createHash('sha256').update(metadata.sourceUri).digest('hex'), sourceType: metadata.sourceType, trustLevel: metadata.trustLevel, classification: metadata.classification,
          acl: { allowedPrincipals: metadata.allowedPrincipals, allowedRoles: metadata.allowedRoles } },
      }).returning();
      const contentHash = ragContentHash(text);
      const provenance = {
        ...scope, sourceId: source.id, chunkId, contentHash,
        trustLevel: metadata.trustLevel, classification: metadata.classification,
        allowedPrincipals: metadata.allowedPrincipals, allowedRoles: metadata.allowedRoles,
        state: state as 'accepted' | 'quarantined',
        sourceVersion: metadata.sourceVersion ?? contentHash,
        ...(metadata.validUntilEpochMs === undefined ? {} : { validUntilEpochMs: metadata.validUntilEpochMs }),
      };
      const signature = signRagProvenance(provenance);
      const [chunk] = await transaction.insert(ragChunks).values({
        ...scope, sourceId: source.id, artifactId: artifact.id, externalChunkId: chunkId,
        contentHash, provenanceSignature: signature, riskAction: decision.action,
        riskScore: score, state, metadata: {
          bundleId: bundle.id,
          sourceVersion: provenance.sourceVersion,
          validUntilEpochMs: provenance.validUntilEpochMs,
          ingestJobId:job.id,ingestAttempt:job.attempt,sourceBinding:job.executionBinding,
        },
      }).onConflictDoUpdate({
        target: [ragChunks.tenantId, ragChunks.applicationId, ragChunks.externalChunkId],
        set: { sourceId:source.id, artifactId:artifact.id, contentHash, provenanceSignature: signature, riskAction: decision.action, riskScore: score, state,
          metadata:{bundleId:bundle.id,sourceVersion:provenance.sourceVersion,validUntilEpochMs:provenance.validUntilEpochMs,ingestJobId:job.id,ingestAttempt:job.attempt,sourceBinding:job.executionBinding} },
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
      signal.throwIfAborted();
      return {result:{action:decision.action,state,sourceId:source.id,chunkId:chunk.externalChunkId,contentHash:chunk.contentHash,provenanceSignature:signature,decision,sourceBinding:job.executionBinding,operationalOutcome:decision.degraded||decision.degradationReasons.length?'INCOMPLETE':decision.action==='REQUIRE_REVIEW'?'REQUIRES_REVIEW':'COMPLETE'}};
    });
    return { jobId: job.id, status: 'completed' };
  } catch (error) {
    if(monitor.signal.aborted||isGuardJobCancellationError(error))return {jobId:job.id,status:'cancelled'};
    await failGuardJob(job, error);
    return { jobId: job.id, status: job.attempt >= job.maxAttempts ? 'failed' : 'retrying' };
  } finally {monitor.stop();}
}
