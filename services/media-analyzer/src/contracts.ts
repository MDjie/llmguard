import {pcmSchema} from '../../../src/lib/media/formats/pcm';
import { z } from 'zod';

const id = z.string().min(1).max(128);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const headers = z.record(z.string().min(1).max(128), z.string().max(4_096))
  .refine((value) => Object.keys(value).length <= 32)
  .refine((value) => Object.keys(value).every((name) =>
    !['host', 'content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase())));
const part = z.object({
  partNumber: z.number().int().positive().max(1_000),
  sizeBytes: z.number().int().nonnegative().max(16 * 1_024 * 1_024),
  sha256,
  url: z.url().max(4_096),
  headers: headers.optional(),
}).strict();
const context = z.object({
  tenantId: id,
  applicationId: id,
}).strict();
const artifact = z.object({
  id,
  kind: z.enum(['IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO']),
  fileName: z.string().max(500).optional(),
  mediaType: z.string().min(1).max(128),
  sizeBytes: z.number().int().nonnegative().max(3 * 1_024 * 1_024 * 1_024),
  sha256,
  parts: z.array(part).min(1).max(1_000),
}).strict();

export const documentImageRequestSchema = z.object({
  contractVersion: z.literal('1.0'),
  context,
  artifact: artifact.extend({ kind: z.enum(['IMAGE', 'DOCUMENT']) }).strict(),
  limits: z.object({
    maxPixels: z.number().int().positive().max(500_000_000),
    maxPages: z.number().int().positive().max(5_000),
    maxFrames: z.number().int().positive().max(10_000),
    maxDecodeSeconds: z.number().int().positive().max(3_600),
    maxDecodedBytes: z.number().int().positive().max(50 * 1_024 * 1_024 * 1_024),
    maxDecompressionRatio: z.number().int().positive().max(1_000),
    disableExternalReferences: z.literal(true),
    disableActiveContent: z.literal(true),
    batchSize: z.number().int().positive().max(64),
    minimumConfidence: z.number().min(0).max(1),
  }).strict(),
  views: z.array(z.object({
    id,
    transform: id,
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    coordinateMapping: z.enum(['identity', 'inverse_affine', 'tile_offset']),
  }).strict()).min(1).max(32),
}).strict();

export const mediaRequestSchema = z.object({
  contractVersion: z.literal('1.0'),
  context,
  artifact: artifact.extend({ kind: z.enum(['AUDIO', 'VIDEO']), pcm: pcmSchema.optional() }).strict().refine(value => !['audio/pcm','audio/l16'].includes(value.mediaType.toLowerCase()) || (value.kind === 'AUDIO' && value.pcm !== undefined), {message:'PCM_METADATA_REQUIRED'}),
  sandbox: z.object({
    ffprobeTimeoutMs: z.number().int().positive().max(120_000),
    ffmpegTimeoutMs: z.number().int().positive().max(30 * 60_000),
    maxDecodedBytes: z.number().int().positive().max(50 * 1_024 * 1_024 * 1_024),
    disableNetworkProtocols: z.literal(true),
    allowedProtocols: z.array(z.enum(['file', 'pipe'])).min(1).max(2),
  }).strict(),
  sampling: z.object({
    strategies: z.array(z.object({
      type: z.enum(['fixed_interval', 'scene_change', 'boundary', 'midpoint', 'short_flash']),
      parameters: z.record(z.string(), z.number()),
    }).strict()).max(16),
    maxFrames: z.number().int().positive().max(10_000),
    maxDurationMs: z.number().int().nonnegative(),
    batchSize: z.number().int().positive().max(64),
    minimumConfidence: z.number().min(0).max(1),
    adaptive: z.object({
      summaryFrames: z.number().int().positive().max(256),
      expansionThreshold: z.number().min(0).max(1),
    }).strict().optional(),
  }).strict(),
  audioViews: z.array(z.enum([
    'original', 'denoise', 'normalize', 'speed_0_9', 'speed_1_1', 'reverse_probe',
  ])).min(1).max(16),
}).strict();

const contentMarkMetadata = z.object({
  schemaVersion: z.literal('1.0'),
  standard: z.literal('GB 45438-2025'),
  generatedContent: z.literal(true),
  modality: z.enum(['image', 'audio', 'video']),
  serviceProvider: id,
  contentId: z.uuid(),
  createdAt: z.iso.datetime(),
}).strict();

export const mediaMarkRequestSchema = z.object({
  contractVersion: z.literal('1.0'),
  context,
  artifact: artifact.extend({ kind: z.enum(['IMAGE', 'AUDIO', 'VIDEO']) }).strict(),
  output: z.object({
    url: z.url().max(4_096),
    headers: headers.optional(),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/mp4', 'video/mp4']),
    maxBytes: z.number().int().positive().max(3 * 1_024 * 1_024 * 1_024),
  }).strict(),
  mark: z.object({
    metadata: contentMarkMetadata,
    signature: z.string().min(43).max(128),
    keyId: id,
    visibleLabel: z.string().trim().min(1).max(64),
  }).strict(),
  limits: z.object({
    timeoutMs: z.number().int().positive().max(30 * 60_000),
  }).strict(),
}).strict().superRefine((value, refinement) => {
  if (value.mark.metadata.modality !== value.artifact.kind.toLowerCase()) {
    refinement.addIssue({
      code: 'custom',
      path: ['mark', 'metadata', 'modality'],
      message: 'mark modality must match artifact kind',
    });
  }
});

export type DocumentImageRequest = z.infer<typeof documentImageRequestSchema>;
export type MediaRequest = z.infer<typeof mediaRequestSchema>;
export type MediaMarkRequest = z.infer<typeof mediaMarkRequestSchema>;

export interface OcrRegion {
  readonly viewId: string;
  readonly text: string;
  readonly confidence: number;
  readonly region: readonly [number, number, number, number];
  readonly page?: number;
  readonly blockId?: number;
  readonly paragraphId?: number;
  readonly lineId?: number;
  readonly wordId?: number;
  readonly sourceRelation: 'OCR_FROM_RENDERED_PAGE' | 'OCR_FROM_IMAGE' | 'OCR_FROM_VIDEO_FRAME';
}

export interface CodeRegion {
  readonly kind: 'QR' | 'BARCODE' | 'DATA_MATRIX';
  readonly text: string;
  readonly confidence: number;
  readonly viewId: string;
  readonly region: readonly [number, number, number, number];
  readonly page?: number;
  readonly frameIndex?: number;
}

export interface VisualLabel {
  readonly viewId: string;
  readonly label: string;
  readonly score: number;
  readonly region?: readonly [number, number, number, number];
  readonly frameIndex?: number;
}

export interface DocumentElement {
  readonly elementId: string;
  readonly kind: 'PAGE' | 'PARAGRAPH' | 'LINE' | 'WORD' | 'EMBEDDED_IMAGE';
  readonly page: number;
  readonly region: readonly [number, number, number, number];
  readonly sourceViewId: string;
  readonly parentElementId?: string;
  readonly embeddedArtifactId?: string;
}

export interface AnalysisFailure {
  readonly component: 'OCR' | 'CODE_READER' | 'VISUAL' | 'ASR' | 'AUDIO_CLASSIFIER' | 'SUBTITLE';
  readonly required: boolean;
  readonly code: string;
}

export interface VisualRisk {
  readonly viewId: string;
  readonly riskType: string;
  readonly score: number;
  readonly region?: readonly [number, number, number, number];
  readonly frameIndex?: number;
  readonly reasonCode: string;
}

export interface TranscriptSegment {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
  readonly source?: 'asr' | 'subtitle';
  readonly sourceViewId?: string;
  readonly speakerId?: string;
  readonly channel?: number;
}

export interface SubtitleSegment extends TranscriptSegment {
  readonly source: 'subtitle';
}
