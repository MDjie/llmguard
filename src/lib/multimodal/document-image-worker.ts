import { analyzeNativeArtifacts } from '@/lib/multimodal/native-analyzer';
import { combineActionConstraints } from '@/lib/guard-engine-v2/action-constraints';
import { runGlmJointEvidence } from './joint-evidence-judge';
import { coverageResult } from '@/lib/multimodal/coverage';
import { and, asc, eq } from 'drizzle-orm';
import { readAcceptedTextArtifact } from '@/lib/artifacts';
import { buildLineageEdge } from '@/lib/data-protection/lineage';
import {
  claimNextGuardJob,
  completeGuardJob,
  failGuardJob,
  isGuardJobCancellationError,
  monitorGuardJobCancellation,
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
  const cancellation = monitorGuardJobCancellation(job);
  try {
    const [artifact] = await db.select().from(artifacts).where(and(
      eq(artifacts.id, job.artifactId),
      eq(artifacts.state, 'accepted'),
      scopePredicate(artifacts, scope),
    )).limit(1);
    if (!artifact) throw new Error('Accepted artifact disappeared');
    const parts = await db.select().from(artifactParts).where(and(
      eq(artifactParts.artifactId, artifact.id),
      scopePredicate(artifactParts, scope),
    )).orderBy(asc(artifactParts.partNumber));
    const detectionPolicy = loadMultimodalDetectionPolicy();
    await updateGuardJobProgress(job, 'sandbox_analysis', 10);
    const analysis = await analyzeDocumentOrImage({
      scope,
      artifact,
      parts,
      detectionPolicy,
      signal: cancellation.signal,
    });
    await updateGuardJobProgress(job, 'ocr_guard', 70, {
      ocrRegions: analysis.ocr.length,
      decodedCodes: analysis.codes.length,
      visualFindings: analysis.visual.length,
      analysisFailures: analysis.analysisFailures.length,
      degraded: analysis.degraded,
    });
    const bundle = await loadVerifiedPolicyBundle(scope, job.bundleId);
    const userText = job.contextArtifactId
      ? await readAcceptedTextArtifact(scope, job.contextArtifactId)
      : undefined;
    const anomalyScore = Math.max(0, ...analysis.anomalies.map((item) => item.score));
    const fusion = await fuseMultimodal({
      analysisCoverage:analysis.coverage,artifactSha256:artifact.verifiedSha256??undefined,
      bundle,
      context: {
        direction: 'INPUT',
        traceId: `job-trace-${job.id}`,
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        absoluteDeadlineEpochMs: Date.now() + 60_000,
      },
      userText,
      contextArtifactId: job.contextArtifactId ?? undefined,
      documentText:analysis.documentText?.map(part=>({...part,artifactId:artifact.id,artifactSha256:artifact.verifiedSha256??undefined})),
      ocr: analysis.ocr.map((item) => ({
        text: item.text,
        confidence: item.confidence,
        artifactId: artifact.id,
        artifactSha256: artifact.verifiedSha256 ?? undefined,
        viewId: item.viewId,
        region: item.region,
        page: item.page,
      })),
      codes: analysis.codes.map((item) => ({
        ...item,
        artifactId: artifact.id,
        artifactSha256: artifact.verifiedSha256 ?? undefined,
      })),
      visual: analysis.visual.map((item) => ({
        ...item,
        artifactId: artifact.id,
        artifactSha256: artifact.verifiedSha256 ?? undefined,
      })),
      analysisFailures: analysis.analysisFailures,
      sourceTrust: 'UNTRUSTED',
      instructionCapability: 'FORBIDDEN',
      anomalyScore,
      minimumConfidence: detectionPolicy.minimumConfidence,
      reviewThreshold: detectionPolicy.reviewThreshold,
      blockThreshold: detectionPolicy.blockThreshold,
    });
    const native = await analyzeNativeArtifacts({ scope, bundlePayload: bundle.payload, requiredRiskIds: bundle.payload.semanticCoverage?.requiredRiskIds ?? [],
      direction: 'INPUT', contextText: userText, contextArtifactId: job.contextArtifactId ?? undefined, heuristicSuspected: fusion.cooperativeAttack,
      artifacts: [{ artifact, parts }], signal: cancellation.signal });
    const jointEvidence = native.binding ? await runGlmJointEvidence({ binding:native.binding, views:fusion.privateEvidenceViews, privateOnly:true, absoluteDeadlineEpochMs:Date.now()+60000, signal:cancellation.signal }) : null;
    const finalEvidence = [...fusion.evidence, ...(jointEvidence?.mode === 'ENFORCE' ? jointEvidence.evidence : [])];
    const requireNative = bundle.payload.semanticDecisionMode === 'coverage-v1';
    fusion.action = combineActionConstraints([fusion.action, ...(jointEvidence ? [jointEvidence.action] : []), ...(requireNative || native.gate.qualified ? [native.gate.action] : [])]).action;
    const coverageSnapshot = coverageResult({ analysisCoverage: analysis.coverage, fusionCoverage: fusion.coverage, action: fusion.action,
      failures: analysis.analysisFailures, strict: bundle.payload.semanticDecisionMode === 'coverage-v1', windowReasons: [...(requireNative && !native.gate.eligible ? native.gate.reasonCodes : []), ...(jointEvidence?.mode==='ENFORCE'?jointEvidence.reasonCodes:[])] });
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
      ...fusion.evidence.map((item) => item.score),
      0,
    ) * 100);
    await db.insert(multimodalFindings).values({
      ...scope,
      jobId: job.id,
      riskType: fusion.cooperativeAttack
        ? 'cross_modal_cooperative_attack'
        : fusion.degraded
          ? 'multimodal_analysis_degraded'
          : 'multimodal_content_risk',
      score,
      action: fusion.action,
      cooperativeAttack: fusion.cooperativeAttack,
      evidence: finalEvidence.map(item => ({ ...item })),
    });
    const result = {
      contractVersion: '1.0',
      ...coverageSnapshot,
      artifactId: artifact.id,
      bundleId: bundle.id,
      action: fusion.action,
      cooperativeAttack: fusion.cooperativeAttack,
      crossModalVerdict: native.gate.verdict, nativeCoverage: native.gate, jointEvidence, relationSources: native.binding?.sources ?? [], relations: native.gate.relations,
      degraded: coverageSnapshot.degraded,
      analysisFailures: analysis.analysisFailures,
      textDecisions: fusion.textDecisions,
      evidence: finalEvidence,
      visual: analysis.visual,
      labels: analysis.labels,
      anomalies: analysis.anomalies,
      documentElements: analysis.documentElements,
      documentText:analysis.documentText?.map(part=>({...part,artifactId:artifact.id,artifactSha256:artifact.verifiedSha256??undefined})),
      ocr: analysis.ocr.map(({ text: _sensitiveText, ...item }) => ({
        ...item,
        textHashOnly: true,
      })),
      codes: analysis.codes.map(({ text: _sensitiveText, ...item }) => ({
        ...item,
        textHashOnly: true,
      })),
      derivatives: analysis.derivatives,
      analyzerVersion: analysis.analyzerVersion,
      coverage: analysis.coverage,
    };
    await completeGuardJob(job, result as unknown as Record<string, unknown>, {views:fusion.privateEvidenceViews,mappings:(analysis.coordinateMappings??[]).map(mapping=>({...mapping,artifactId:artifact.id}))});
    return { jobId: job.id, status: 'completed' };
  } catch (error) {
    if (cancellation.signal.aborted || isGuardJobCancellationError(error)) {
      return { jobId: job.id, status: 'cancelled' };
    }
    await failGuardJob(job, error);
    return { jobId: job.id, status: job.attempt >= job.maxAttempts ? 'failed' : 'retrying' };
  } finally {
    cancellation.stop();
  }
}
