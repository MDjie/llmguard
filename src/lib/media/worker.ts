import { and, asc, eq } from 'drizzle-orm';
import {
  claimNextGuardJob,
  completeGuardJob,
  failGuardJob,
  updateGuardJobProgress,
} from '@/lib/guard-jobs';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifactParts, artifacts, mediaTimelineFindings } from '@/storage/database/shared/schema';
import { analyzeAudioVideo } from './analyzer';
import { fuseMediaTimeline } from './timeline-fusion';

export async function processNextAudioVideoJob() {
  const job = await claimNextGuardJob(['audio_video']);
  if (!job) return null;
  const scope = { tenantId: job.tenantId, applicationId: job.applicationId };
  try {
    const [artifact] = await db.select().from(artifacts).where(and(
      eq(artifacts.id, job.artifactId), eq(artifacts.state, 'accepted'), scopePredicate(artifacts, scope),
    )).limit(1);
    if (!artifact || !['AUDIO', 'VIDEO'].includes(artifact.kind)) throw new Error('Accepted audio/video artifact disappeared');
    const parts = await db.select().from(artifactParts).where(and(
      eq(artifactParts.artifactId, artifact.id), scopePredicate(artifactParts, scope),
    )).orderBy(asc(artifactParts.partNumber));
    await updateGuardJobProgress(job, 'demux_decode_asr', 10);
    const analysis = await analyzeAudioVideo({ scope, artifact, parts });
    await updateGuardJobProgress(job, 'timeline_fusion', 75, {
      durationMs: analysis.durationMs,
      transcriptSegments: analysis.transcript.length,
      sampledFrames: analysis.frames.length,
    });
    const bundle = await loadVerifiedPolicyBundle(scope, job.bundleId);
    const anomalyScore = Math.max(0, ...analysis.anomalies.map((item) => item.score));
    const fusion = await fuseMediaTimeline({
      bundle,
      context: {
        traceId: `media-trace-${job.id}`, tenantId: scope.tenantId, applicationId: scope.applicationId,
        absoluteDeadlineEpochMs: Date.now() + 60_000,
      },
      segments: [
        ...analysis.transcript.map((item) => ({ ...item, source: 'audio' as const })),
        ...analysis.frames.filter((item) => item.ocrText).map((item) => ({
          source: 'frame_ocr' as const, text: item.ocrText!, startMs: item.timeMs,
          endMs: item.timeMs, frameIndex: item.frameIndex,
        })),
      ],
      visual: analysis.frames.flatMap((frame) => frame.risks.map((risk) => ({
        ...risk, timeMs: frame.timeMs, frameIndex: frame.frameIndex,
      }))),
      anomalyScore,
    });
    const rows = [
      ...fusion.evidence.map((item) => ({
        ...scope, jobId: job.id, riskType: item.riskType, score: Math.round(item.score * 100),
        action: item.action, startMs: item.startMs, endMs: item.endMs,
        frameIndex: item.frameIndex, region: 'region' in item ? item.region : undefined,
        contentHmac: 'contentHmac' in item ? item.contentHmac : undefined,
        reasonCode: item.reasonCode,
      })),
      ...analysis.anomalies.map((item) => ({
        ...scope, jobId: job.id, riskType: 'media_obfuscation', score: Math.round(item.score * 100),
        action: item.score >= 0.8 ? 'BLOCK' : 'WARN', startMs: item.startMs, endMs: item.endMs,
        reasonCode: `MEDIA_${item.type.toUpperCase()}`,
      })),
    ];
    if (rows.length > 0) await db.insert(mediaTimelineFindings).values(rows);
    await completeGuardJob(job, {
      contractVersion: '1.0', artifactId: artifact.id, bundleId: bundle.id,
      action: fusion.action, cooperativeAttack: fusion.cooperativeAttack,
      durationMs: analysis.durationMs, format: analysis.format,
      decisions: fusion.decisions,
      evidence: fusion.evidence,
      anomalies: analysis.anomalies,
      analyzerVersion: analysis.analyzerVersion,
    } as unknown as Record<string, unknown>);
    return { jobId: job.id, status: 'completed' };
  } catch (error) {
    await failGuardJob(job, error);
    return { jobId: job.id, status: job.attempt >= job.maxAttempts ? 'failed' : 'retrying' };
  }
}
