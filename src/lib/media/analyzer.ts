import {pcmFromMetadata} from '@/lib/media/formats/pcm';
import { z } from 'zod';
import { analysisCoverageSchema } from '@/lib/multimodal/coverage';
import { ProviderEndpointPolicy, safeFetchJson } from '@/lib/egress';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
import type { TenantScope } from '@/lib/tenancy';
import type { artifactParts, artifacts } from '@/storage/database/shared/schema';
import { createVideoSamplingPlan } from './sampling-plan';
import {
  loadMultimodalDetectionPolicy,
  type MultimodalDetectionPolicy,
} from '@/lib/multimodal/detection-policy';

const region = z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]);
const mediaAnalysisSchema = z.object({
  analyzerVersion: z.string().min(1).max(100),
  coordinateMappings:z.array(z.record(z.string(),z.unknown())).max(10000).optional(),
  coverage:analysisCoverageSchema.optional(),
  format: z.string().min(1).max(100),
  durationMs: z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1_000),
  transcript: z.array(z.object({
    text: z.string().max(100_000), startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(), confidence: z.number().min(0).max(1),
    source: z.enum(['asr', 'subtitle']).optional(),
    sourceViewId: z.string().min(1).max(128).optional(),
    speakerId: z.string().min(1).max(128).optional(),
    channel: z.number().int().nonnegative().max(64).optional(),
  }).strict().refine((item) => item.endMs >= item.startMs)).max(100_000),
  subtitles: z.array(z.object({
    text: z.string().max(100_000), startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(), confidence: z.number().min(0).max(1),
    source: z.literal('subtitle'),
    sourceViewId:z.string().max(128).optional(),channel:z.number().int().nonnegative().max(64).optional(),
  }).strict().refine((item) => item.endMs >= item.startMs)).max(100_000),
  frames: z.array(z.object({
    frameIndex: z.number().int().nonnegative(), timeMs: z.number().int().nonnegative(),
    ocrText: z.string().max(100_000).optional(),
    codes: z.array(z.object({
      kind: z.enum(['QR', 'BARCODE', 'DATA_MATRIX']), text: z.string().max(16_384),
      confidence: z.number().min(0).max(1), viewId: z.string().min(1).max(100),
      region: region, frameIndex: z.number().int().nonnegative().optional(),
    }).strict()).max(100),
    labels: z.array(z.object({
      viewId: z.string().min(1).max(100), label: z.string().min(1).max(128),
      score: z.number().min(0).max(1), region: region.optional(),
      frameIndex: z.number().int().nonnegative().optional(),
    }).strict()).max(1_000),
    risks: z.array(z.object({
      riskType: z.string().min(1).max(128), score: z.number().min(0).max(1),
      reasonCode: z.string().min(1).max(128), region: region.optional(),
    }).strict()).max(100),
  }).strict()).max(10_000),
  analysisFailures: z.array(z.object({
    component: z.enum(['OCR', 'CODE_READER', 'VISUAL', 'ASR', 'AUDIO_CLASSIFIER', 'SUBTITLE']),
    required: z.boolean(), code: z.string().regex(/^ANALYZER_[A-Z0-9_:.-]+$/u).max(160),
  }).strict()).max(100),
  degraded: z.boolean(),
  samplingPhase: z.enum(['summary', 'expanded']),
  anomalies: z.array(z.object({
    type: z.enum(['noise', 'ultrasonic', 'speed_change', 'reversed_audio', 'short_flash', 'hidden_middle', 'track_mismatch']),
    score: z.number().min(0).max(1), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(),
  }).strict()).max(1_000),
}).strict();

export type MediaAnalysis = z.infer<typeof mediaAnalysisSchema>;

function list(value: string | undefined) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export async function analyzeAudioVideo(input: {
  scope: TenantScope;
  artifact: typeof artifacts.$inferSelect;
  parts: readonly (typeof artifactParts.$inferSelect)[];
  detectionPolicy?: MultimodalDetectionPolicy;
  signal?: AbortSignal;
}): Promise<MediaAnalysis> {
  const baseUrl = process.env.MEDIA_ANALYZER_BASE_URL;
  if (!baseUrl) throw new Error('MEDIA_ANALYZER_BASE_URL is required');
  const sharedToken = process.env.ANALYZER_SHARED_TOKEN;
  if (!sharedToken || Buffer.byteLength(sharedToken) < 32) {
    throw new Error('ANALYZER_SHARED_TOKEN must contain at least 32 bytes');
  }
  const signer = new S3Presigner(objectStoreConfig());
  const signedParts = await Promise.all(input.parts.map(async (part) => ({
    partNumber: part.partNumber, sizeBytes: part.sizeBytes, sha256: part.sha256,
    ...(await signer.presign('GET', part.objectKey, { expiresSeconds: 300 })),
  })));
  const policy = new ProviderEndpointPolicy({
    allowedHosts: list(process.env.MEDIA_ANALYZER_ALLOWED_HOSTS),
    allowedPrivateHosts: list(process.env.MEDIA_ANALYZER_ALLOWED_PRIVATE_HOSTS),
  });
  const detectionPolicy = input.detectionPolicy ?? loadMultimodalDetectionPolicy();
  const result = await safeFetchJson({
    baseUrl, path: '/v1/analyze/audio-video', providerType: 'custom', signal: input.signal,
    timeoutMs: 300_000,
    maxRequestBytes: 512 * 1_024, maxResponseBytes: 32 * 1_024 * 1_024,
    headers: { 'X-Analyzer-Token': sharedToken },
    body: {
      contractVersion: '1.0', context: input.scope,
      artifact: {
        id: input.artifact.id, kind: input.artifact.kind, mediaType: input.artifact.detectedMediaType,
        sizeBytes: input.artifact.verifiedSize, sha256: input.artifact.verifiedSha256, parts: signedParts,
        fileName: input.artifact.fileName, pcm: pcmFromMetadata(input.artifact.fileName, input.artifact.metadata, input.artifact.verifiedSize ?? 0),
      },
      sandbox: {
        ffprobeTimeoutMs: 30_000, ffmpegTimeoutMs: 300_000,
        maxDecodedBytes: 20 * 1024 * 1024 * 1024,
        disableNetworkProtocols: true, allowedProtocols: ['file', 'pipe'],
      },
      sampling: {
        ...createVideoSamplingPlan(detectionPolicy.maxDurationMs, {
          intervalMs: detectionPolicy.frameIntervalMs,
          maxFrames: detectionPolicy.maxFrames,
        }),
        batchSize: detectionPolicy.frameBatchSize,
        minimumConfidence: detectionPolicy.minimumConfidence,
        adaptive: {
          summaryFrames: detectionPolicy.summaryFrames,
          expansionThreshold: detectionPolicy.reviewThreshold,
        },
      },
      audioViews: ['original', 'denoise', 'normalize', 'speed_0_9', 'speed_1_1', 'reverse_probe'],
    },
  }, { policy });
  return mediaAnalysisSchema.parse(result);
}
