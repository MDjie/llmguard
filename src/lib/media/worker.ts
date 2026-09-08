import { analyzeNativeArtifacts } from '@/lib/multimodal/native-analyzer';
import { combineActionConstraints } from '@/lib/guard-engine-v2/action-constraints';
import { runGlmJointEvidence } from '@/lib/multimodal/joint-evidence-judge';
import { coverageResult } from '@/lib/multimodal/coverage';
import { and, asc, eq } from 'drizzle-orm';
import {
  claimNextGuardJob,
  completeGuardJob,
  failGuardJob,
  isGuardJobCancellationError,
  monitorGuardJobCancellation,
  updateGuardJobProgress,
} from '@/lib/guard-jobs';
import { readAcceptedTextArtifact } from '@/lib/artifacts';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifactParts, artifacts, mediaTimelineFindings } from '@/storage/database/shared/schema';
import { analyzeAudioVideo } from './analyzer';
import { fuseMediaTimeline } from './timeline-fusion';
import { loadMultimodalDetectionPolicy } from '@/lib/multimodal/detection-policy';

export async function processNextAudioVideoJob() {
  const job = await claimNextGuardJob(['audio_video']);
  if (!job) return null;
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  const cancellation = monitorGuardJobCancellation(job);
  try {
    const [artifact] = await db.select().from(artifacts).where(and(
      eq(artifacts.id, job.artifactId),
      eq(artifacts.state, 'accepted'),
      scopePredicate(artifacts, scope),
    )).limit(1);
    if (!artifact || !['AUDIO', 'VIDEO'].includes(artifact.kind)) {
      throw new Error('Accepted audio/video artifact disappeared');
    }
    const parts = await db.select().from(artifactParts).where(and(
      eq(artifactParts.artifactId, artifact.id),
      scopePredicate(artifactParts, scope),
    )).orderBy(asc(artifactParts.partNumber));
    const detectionPolicy = loadMultimodalDetectionPolicy();
    await updateGuardJobProgress(job, 'demux_decode_asr', 10);
    const analysis = await analyzeAudioVideo({
      scope,
      artifact,
      parts,
      detectionPolicy,
      signal: cancellation.signal,
    });
    await updateGuardJobProgress(job, 'timeline_fusion', 75, {
      durationMs: analysis.durationMs,
      transcriptSegments: analysis.transcript.length,
      subtitleSegments: analysis.subtitles.length,
      sampledFrames: analysis.frames.length,
      samplingPhase: analysis.samplingPhase,
      analysisFailures: analysis.analysisFailures.length,
      degraded: analysis.degraded,
    });
    const bundle = await loadVerifiedPolicyBundle(scope, job.bundleId);
    const userText = job.contextArtifactId
      ? await readAcceptedTextArtifact(scope, job.contextArtifactId)
      : undefined;
    const anomalyScore = Math.max(0, ...analysis.anomalies.map((item) => item.score));
    const fusion = await fuseMediaTimeline({
      artifactId: artifact.id,
      bundle,
      context: {
        direction: 'INPUT',
        traceId: `media-trace-${job.id}`,
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        absoluteDeadlineEpochMs: Date.now() + 60_000,
      },
      userText,
      contextArtifactId: job.contextArtifactId ?? undefined,
      segments: [
        ...analysis.transcript.map((item) => ({
          source: 'audio' as const,
          text: item.text,
          startMs: item.startMs,
          endMs: item.endMs,
          viewId: item.sourceViewId,
          speakerId: item.speakerId,
          channel: item.channel,
        })),
        ...analysis.subtitles.map((item) => ({
          source: 'subtitle' as const,
          text: item.text,
          startMs: item.startMs,
          endMs: item.endMs,
        })),
        ...analysis.frames.filter((item) => item.ocrText).map((item) => ({
          source: 'frame_ocr' as const,
          text: item.ocrText!,
          startMs: item.timeMs,
          endMs: item.timeMs,
          frameIndex: item.frameIndex,
          viewId: `frame_${item.frameIndex}`,
        })),
        ...analysis.frames.flatMap((frame) => frame.codes.map((code) => ({
          source: 'qr_code' as const,
          text: code.text,
          startMs: frame.timeMs,
          endMs: frame.timeMs,
          frameIndex: frame.frameIndex,
          viewId: code.viewId,
        }))),
      ],
      visual: analysis.frames.flatMap((frame) => frame.risks.map((risk) => ({
        ...risk,
        timeMs: frame.timeMs,
        frameIndex: frame.frameIndex,
      }))),
      analysisFailures: analysis.analysisFailures,
      analysisCoverage:analysis.coverage,artifactSha256:artifact.verifiedSha256??undefined,
      sourceTrust: 'UNTRUSTED',
      instructionCapability: 'FORBIDDEN',
      anomalyScore,
      crossModalWindowMs: detectionPolicy.crossModalWindowMs,
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
      failures: analysis.analysisFailures, strict: bundle.payload.semanticDecisionMode === 'coverage-v1', windowReasons: [...fusion.windowCoverage.reasonCodes, ...(requireNative && !native.gate.eligible ? native.gate.reasonCodes : []), ...(jointEvidence?.mode==='ENFORCE'?jointEvidence.reasonCodes:[])] });
    const rows = [
      ...finalEvidence.map((item) => ({
        ...scope,
        jobId: job.id,
        riskType: item.riskType,
        score: Math.round(item.score * 100),
        action: item.action,
        startMs: 'startMs' in item ? item.startMs : undefined,
        endMs: 'endMs' in item ? item.endMs : undefined,
        frameIndex: 'frameIndex' in item ? item.frameIndex : undefined,
        region: 'region' in item ? item.region : undefined,
        contentHmac: 'contentHmac' in item ? item.contentHmac : undefined,
        reasonCode: item.reasonCode,
      })),
      ...analysis.anomalies.map((item) => ({
        ...scope,
        jobId: job.id,
        riskType: 'media_obfuscation',
        score: Math.round(item.score * 100),
        action: item.score >= detectionPolicy.blockThreshold
          ? 'BLOCK' as const
          : item.score >= detectionPolicy.reviewThreshold
            ? 'REQUIRE_REVIEW' as const
            : item.score >= 0.5
              ? 'WARN' as const
              : 'ALLOW' as const,
        startMs: item.startMs,
        endMs: item.endMs,
        reasonCode: `MEDIA_${item.type.toUpperCase()}`,
      })),
    ];
    if (rows.length > 0) await db.insert(mediaTimelineFindings).values(rows);
    await completeGuardJob(job, {
      contractVersion: '1.0',
      ...coverageSnapshot,
      artifactId: artifact.id,
      bundleId: bundle.id,
      action: fusion.action,
      cooperativeAttack: fusion.cooperativeAttack,
      crossModalVerdict: native.gate.verdict, nativeCoverage: native.gate, jointEvidence, relationSources: native.binding?.sources ?? [], relations: native.gate.relations,
      evidenceConflict: fusion.evidenceConflict,
      degraded: coverageSnapshot.degraded,
      analysisFailures: analysis.analysisFailures,
      windowCoverage: fusion.windowCoverage,
      samplingPhase: analysis.samplingPhase,
      durationMs: analysis.durationMs,
      format: analysis.format,
      decisions: fusion.decisions,
      evidence: finalEvidence,
      anomalies: analysis.anomalies,
      frameSummary: analysis.frames.map((frame) => ({
        frameIndex: frame.frameIndex,
        timeMs: frame.timeMs,
        hasOcrText: Boolean(frame.ocrText),
        decodedCodeCount: frame.codes.length,
        labelCount: frame.labels.length,
        riskCount: frame.risks.length,
      })),
      analyzerVersion: analysis.analyzerVersion,
    } as unknown as Record<string, unknown>, {views:fusion.privateEvidenceViews,mappings:(analysis.coordinateMappings??[]).map(mapping=>({...mapping,artifactId:artifact.id}))});
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
