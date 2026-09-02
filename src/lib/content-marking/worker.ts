import { and, asc, eq } from 'drizzle-orm';
import { buildLineageEdge } from '@/lib/data-protection/lineage';
import {
  claimNextGuardJob,
  completeGuardJob,
  failGuardJob,
  updateGuardJobProgress,
} from '@/lib/guard-jobs';
import { scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  artifactParts,
  artifacts,
  dataLineageEdges,
  generatedContentDerivatives,
  generatedContentMarks,
} from '@/storage/database/shared/schema';
import { markMediaArtifact } from './media';

export async function processNextContentMarkingJob() {
  const job = await claimNextGuardJob(['content_mark']);
  if (!job) return null;
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  try {
    const [artifact] = await db.select().from(artifacts).where(and(
      eq(artifacts.id, job.artifactId),
      eq(artifacts.ownerId, job.ownerId),
      eq(artifacts.state, 'accepted'),
      scopePredicate(artifacts, scope),
    )).limit(1);
    if (!artifact || !['IMAGE', 'AUDIO', 'VIDEO'].includes(artifact.kind)) {
      throw new Error('Accepted markable media artifact disappeared');
    }
    const parts = await db.select().from(artifactParts).where(and(
      eq(artifactParts.artifactId, artifact.id),
      scopePredicate(artifactParts, scope),
    )).orderBy(asc(artifactParts.partNumber));
    await updateGuardJobProgress(job, 'content_marking', 10);
    const marked = await markMediaArtifact({
      scope,
      artifact,
      parts,
      contentId: job.id,
    });
    await updateGuardJobProgress(job, 'persisting_mark', 90);
    await db.transaction(async (transaction) => {
      let [contentMark] = await transaction.select().from(generatedContentMarks).where(and(
        eq(generatedContentMarks.contentId, marked.mark.metadata.contentId),
        scopePredicate(generatedContentMarks, scope),
      )).limit(1);
      if (!contentMark) {
        [contentMark] = await transaction.insert(generatedContentMarks).values({
          ...scope,
          contentId: marked.mark.metadata.contentId,
          modality: marked.mark.metadata.modality,
          serviceProvider: marked.mark.metadata.serviceProvider,
          generatedContent: true,
          explicitMarkApplied: true,
          metadata: { ...marked.mark.metadata },
          metadataSignature: marked.mark.signature,
          hashKeyId: marked.mark.keyId,
          contentHash: marked.result.output.sha256,
          createdBy: job.ownerId,
          createdAt: new Date(marked.mark.metadata.createdAt),
        }).returning();
      }
      if (!contentMark) throw new Error('Content mark persistence failed');
      let [derivative] = await transaction.insert(generatedContentDerivatives).values({
        ...scope,
        contentMarkId: contentMark.id,
        sourceArtifactId: artifact.id,
        outputObjectKey: marked.outputObjectKey,
        mediaType: marked.result.output.mediaType,
        sizeBytes: marked.result.output.sizeBytes,
        sha256: marked.result.output.sha256,
        visibleMarkApplied: marked.result.visibleMarkApplied,
        spokenMarkApplied: marked.result.spokenMarkApplied,
        metadataEmbedded: marked.result.metadataEmbedded,
        analyzerVersion: marked.result.analyzerVersion,
        createdBy: job.ownerId,
      }).onConflictDoNothing().returning();
      if (!derivative) {
        [derivative] = await transaction.select().from(generatedContentDerivatives).where(and(
          eq(generatedContentDerivatives.contentMarkId, contentMark.id),
          scopePredicate(generatedContentDerivatives, scope),
        )).limit(1);
      }
      if (!derivative) throw new Error('Generated media derivative persistence failed');
      await transaction.insert(dataLineageEdges).values([
        buildLineageEdge({
          tenantId: scope.tenantId,
          applicationId: scope.applicationId,
          sourceType: 'ARTIFACT',
          sourceId: artifact.id,
          targetType: 'CONTENT_MARK',
          targetId: contentMark.id,
          operation: 'MEDIA_MARKING',
          processorId: 'guardllm-content-marker',
          processorVersion: marked.result.analyzerVersion,
          attributes: {
            contentId: marked.mark.metadata.contentId,
            modality: marked.mark.metadata.modality,
          },
        }),
        buildLineageEdge({
          tenantId: scope.tenantId,
          applicationId: scope.applicationId,
          sourceType: 'CONTENT_MARK',
          sourceId: contentMark.id,
          targetType: 'GENERATED_MEDIA',
          targetId: derivative.id,
          operation: 'MEDIA_RENDER',
          processorId: 'guardllm-content-marker',
          processorVersion: marked.result.analyzerVersion,
          attributes: {
            outputObjectKey: derivative.outputObjectKey,
            sha256: derivative.sha256,
            mediaType: derivative.mediaType,
          },
        }),
      ]).onConflictDoNothing();
    });
    const result = {
      contractVersion: '1.0',
      contentId: marked.mark.metadata.contentId,
      modality: marked.mark.metadata.modality,
      output: marked.result.output,
      visibleMarkApplied: marked.result.visibleMarkApplied,
      spokenMarkApplied: marked.result.spokenMarkApplied,
      metadataEmbedded: marked.result.metadataEmbedded,
      analyzerVersion: marked.result.analyzerVersion,
    };
    await completeGuardJob(job, result);
    return { jobId: job.id, status: 'completed' };
  } catch (error) {
    await failGuardJob(job, error);
    return { jobId: job.id, status: job.attempt >= job.maxAttempts ? 'failed' : 'retrying' };
  }
}
