import { and, asc, eq } from 'drizzle-orm';
import { readAcceptedTextArtifact } from '@/lib/artifacts';
import { buildLineageEdge } from '@/lib/data-protection/lineage';
import {
  claimNextGuardJob,
  completeGuardJob,
  failGuardJob,
  updateGuardJobProgress,
} from '@/lib/guard-jobs';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  artifactDerivatives,
  artifactParts,
  artifacts,
  dataLineageEdges,
  multimodalFindings,
} from '@/storage/database/shared/schema';
import { analyzeDocumentOrImage } from './analyzer';
import { fuseMultimodal } from './fusion';
import { loadMultimodalDetectionPolicy } from './detection-policy';

export async function processNextDocumentImageJob() {
  const job = await claimNextGuardJob(['document_image']);
  if (!job) return null;
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  try {
    const [artifact] = await db.select().from(artifacts).where(and(
      eq(artifacts.id, job.artifactId), eq(artifacts.state, 'accepted'), scopePredicate(artifacts, scope),
    )).limit(1);
    if (!artifact) throw new Error('Accepted artifact disappeared');
    const parts = await db.select().from(artifactParts).where(and(
      eq(artifactParts.artifactId, artifact.id), scopePredicate(artifactParts, scope),
    )).orderBy(asc(artifactParts.partNumber));
    const detectionPolicy = loadMultimodalDetectionPolicy();
    await updateGuardJobProgress(job, 'sandbox_analysis', 10);
    const analysis = await analyzeDocumentOrImage({
      scope, artifact, parts, detectionPolicy,
    });
    await updateGuardJobProgress(job, 'ocr_guard', 70, {
      ocrRegions: analysis.ocr.length,
      visualFindings: analysis.visual.length,
    });
    const bundle = await loadVerifiedPolicyBundle(scope, job.bundleId);
    const userText = job.contextArtifactId
      ? await readAcceptedTextArtifact(scope, job.contextArtifactId)
      : undefined;
    const anomalyScore = Math.max(0, ...analysis.anomalies.map((item) => item.score));
    const fusion = await fuseMultimodal({
      bundle,
      context: {
        traceId: `job-trace-${job.id}`,
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        absoluteDeadlineEpochMs: Date.now() + 60_000,
      },
      userText,
      contextArtifactId: job.contextArtifactId ?? undefined,
      ocr: analysis.ocr.map((item) => ({
        text: item.text,
        artifactId: artifact.id,
        viewId: item.viewId,
        region: item.region,
      })),
      visual: analysis.visual.map((item) => ({
        ...item,
        artifactId: artifact.id,
      })),
      anomalyScore,
      reviewThreshold: detectionPolicy.reviewThreshold,
      blockThreshold: detectionPolicy.blockThreshold,
    });
    if (analysis.derivatives.length > 0) {
      await db.transaction(async (transaction) => {
        const created = await transaction.insert(artifactDerivatives)
          .values(analysis.derivatives.map((item) => ({
            ...scope,
            artifactId: item.artifactId,
            parentArtifactId: artifact.id,
            viewId: item.viewId,
            transform: item.transform,
            coordinateMapping: item.coordinateMapping,
            sha256: item.sha256,
          })))
          .onConflictDoNothing()
          .returning({
            id: artifactDerivatives.id,
            artifactId: artifactDerivatives.artifactId,
            viewId: artifactDerivatives.viewId,
            transform: artifactDerivatives.transform,
            sha256: artifactDerivatives.sha256,
          });
        if (created.length > 0) {
          await transaction.insert(dataLineageEdges).values(created.map((item) =>
            buildLineageEdge({
              tenantId: scope.tenantId,
              applicationId: scope.applicationId,
              sourceType: 'ARTIFACT',
              sourceId: artifact.id,
              targetType: 'ARTIFACT_DERIVATIVE',
              targetId: item.id,
              operation: 'VISUAL_TRANSFORM',
              processorId: 'guardllm-multimodal-analyzer',
              processorVersion: analysis.analyzerVersion,
              attributes: {
                derivedArtifactId: item.artifactId,
                viewId: item.viewId,
                transform: item.transform,
                sha256: item.sha256,
              },
            }),
          )).onConflictDoNothing();
        }
      });
    }
    const score = Math.round(Math.max(
      anomalyScore,
      ...analysis.visual.map((item) => item.score),
      ...fusion.textDecisions.combined.observations.map((item) => item.score),
      0,
    ) * 100);
    await db.insert(multimodalFindings).values({
      ...scope,
      jobId: job.id,
      riskType: fusion.cooperativeAttack ? 'cross_modal_cooperative_attack' : 'multimodal_content_risk',
      score,
      action: fusion.action,
      cooperativeAttack: fusion.cooperativeAttack,
      evidence: fusion.evidence,
    });
    const result = {
      contractVersion: '1.0',
      artifactId: artifact.id,
      bundleId: bundle.id,
      action: fusion.action,
      cooperativeAttack: fusion.cooperativeAttack,
      textDecisions: fusion.textDecisions,
      evidence: fusion.evidence,
      visual: analysis.visual,
      anomalies: analysis.anomalies,
      ocr: analysis.ocr.map((item) => ({ ...item, textHashOnly: true, text: undefined })),
      derivatives: analysis.derivatives,
      analyzerVersion: analysis.analyzerVersion,
    };
    await completeGuardJob(job, result as unknown as Record<string, unknown>);
    return { jobId: job.id, status: 'completed' };
  } catch (error) {
    await failGuardJob(job, error);
    return { jobId: job.id, status: job.attempt >= job.maxAttempts ? 'failed' : 'retrying' };
  }
}
