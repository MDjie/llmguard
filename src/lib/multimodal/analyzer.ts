import { z } from 'zod';
import { ProviderEndpointPolicy, safeFetchJson } from '@/lib/egress';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
import type { TenantScope } from '@/lib/tenancy';
import type { artifactParts, artifacts } from '@/storage/database/shared/schema';
import { createImageViewPlan } from './view-plan';
import { analysisCoverageSchema } from './coverage';
import {
  loadMultimodalDetectionPolicy,
  type MultimodalDetectionPolicy,
} from './detection-policy';

const regionSchema = z.tuple([
  z.number().nonnegative(), z.number().nonnegative(),
  z.number().nonnegative(), z.number().nonnegative(),
]);
const analysisSchema = z.object({
  coverage:analysisCoverageSchema.optional(),
  analyzerVersion: z.string().min(1).max(100),
  ocr: z.array(z.object({
    viewId: z.string().min(1).max(100),
    text: z.string().max(100_000),
    confidence: z.number().min(0).max(1),
    region: regionSchema,
    page: z.number().int().positive().optional(),
    blockId: z.number().int().nonnegative().optional(),
    paragraphId: z.number().int().nonnegative().optional(),
    lineId: z.number().int().nonnegative().optional(),
    wordId: z.number().int().nonnegative().optional(),
    sourceRelation: z.enum(['OCR_FROM_RENDERED_PAGE', 'OCR_FROM_IMAGE', 'OCR_FROM_VIDEO_FRAME']),
  }).strict()).max(100_000),
  codes: z.array(z.object({
    kind: z.enum(['QR', 'BARCODE', 'DATA_MATRIX']),
    text: z.string().max(16_384),
    confidence: z.number().min(0).max(1),
    viewId: z.string().min(1).max(100),
    region: regionSchema,
    page: z.number().int().positive().optional(),
    frameIndex: z.number().int().nonnegative().optional(),
  }).strict()).max(10_000),
  labels: z.array(z.object({
    viewId: z.string().min(1).max(100),
    label: z.string().min(1).max(128),
    score: z.number().min(0).max(1),
    region: regionSchema.optional(),
    frameIndex: z.number().int().nonnegative().optional(),
  }).strict()).max(10_000),
  documentElements: z.array(z.object({
    elementId: z.string().min(1).max(128),
    kind: z.enum(['PAGE', 'PARAGRAPH', 'LINE', 'WORD', 'EMBEDDED_IMAGE']),
    page: z.number().int().positive(),
    region: regionSchema,
    sourceViewId: z.string().min(1).max(100),
    parentElementId: z.string().min(1).max(128).optional(),
    embeddedArtifactId: z.string().min(1).max(128).optional(),
  }).strict()).max(100_000),
  visual: z.array(z.object({
    viewId: z.string().min(1).max(100),
    riskType: z.string().min(1).max(128),
    score: z.number().min(0).max(1),
    region: regionSchema.optional(),
    frameIndex: z.number().int().nonnegative().optional(),
    reasonCode: z.string().min(1).max(128),
  }).strict()).max(10_000),
  anomalies: z.array(z.object({
    type: z.enum(['rotation', 'occlusion', 'mosaic', 'noise', 'reorder', 'adversarial_patch', 'decoder_disagreement']),
    score: z.number().min(0).max(1),
    viewIds: z.array(z.string().max(100)).max(32),
  }).strict()).max(100),
  analysisFailures: z.array(z.object({
    component: z.enum(['OCR', 'CODE_READER', 'VISUAL', 'ASR', 'AUDIO_CLASSIFIER', 'SUBTITLE']),
    required: z.boolean(),
    code: z.string().regex(/^ANALYZER_[A-Z0-9_:.-]+$/u).max(160),
  }).strict()).max(100),
  degraded: z.boolean(),
  derivatives: z.array(z.object({
    artifactId: z.string().min(1).max(128),
    parentArtifactId: z.string().min(1).max(128),
    viewId: z.string().min(1).max(100),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    transform: z.string().min(1).max(100),
    coordinateMapping: z.record(z.string(), z.unknown()),
  }).strict()).max(100),
}).strict();

export type MultimodalAnalysis = z.infer<typeof analysisSchema>;

function configured(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export async function analyzeDocumentOrImage(input: {
  scope: TenantScope;
  artifact: typeof artifacts.$inferSelect;
  parts: readonly (typeof artifactParts.$inferSelect)[];
  signal?: AbortSignal;
  detectionPolicy?: MultimodalDetectionPolicy;
}): Promise<MultimodalAnalysis> {
  const baseUrl = process.env.MULTIMODAL_ANALYZER_BASE_URL;
  if (!baseUrl) throw new Error('MULTIMODAL_ANALYZER_BASE_URL is required');
  const sharedToken = process.env.ANALYZER_SHARED_TOKEN;
  if (!sharedToken || Buffer.byteLength(sharedToken) < 32) {
    throw new Error('ANALYZER_SHARED_TOKEN must contain at least 32 bytes');
  }
  const signer = new S3Presigner(objectStoreConfig());
  const signedParts = await Promise.all(input.parts.map(async (part) => ({
    partNumber: part.partNumber,
    sizeBytes: part.sizeBytes,
    sha256: part.sha256,
    ...(await signer.presign('GET', part.objectKey, { expiresSeconds: 300 })),
  })));
  const policy = new ProviderEndpointPolicy({
    allowedHosts: configured(process.env.MULTIMODAL_ANALYZER_ALLOWED_HOSTS),
    allowedPrivateHosts: configured(process.env.MULTIMODAL_ANALYZER_ALLOWED_PRIVATE_HOSTS),
  });
  const detectionPolicy = input.detectionPolicy ?? loadMultimodalDetectionPolicy();
  const response = await safeFetchJson({
    baseUrl,
    path: '/v1/analyze/document-image',
    providerType: 'custom',
    signal: input.signal,
    timeoutMs: 120_000,
    maxRequestBytes: 512 * 1_024,
    maxResponseBytes: 16 * 1_024 * 1_024,
    headers: { 'X-Analyzer-Token': sharedToken },
    body: {
      contractVersion: '1.0',
      context: input.scope,
      artifact: {
        id: input.artifact.id,
        kind: input.artifact.kind,
        fileName: input.artifact.fileName,
        mediaType: input.artifact.detectedMediaType,
        sizeBytes: input.artifact.verifiedSize,
        sha256: input.artifact.verifiedSha256,
        parts: signedParts,
      },
      limits: {
        maxPixels: detectionPolicy.maxPixels,
        maxPages: 5_000,
        maxFrames: detectionPolicy.maxFrames,
        maxDecodeSeconds: 300,
        maxDecodedBytes: detectionPolicy.maxDecodedBytes,
        maxDecompressionRatio: detectionPolicy.maxDecompressionRatio,
        disableExternalReferences: true,
        disableActiveContent: true,
        batchSize: detectionPolicy.frameBatchSize,
        minimumConfidence: detectionPolicy.minimumConfidence,
      },
      views: createImageViewPlan(),
    },
  }, { policy });
  return analysisSchema.parse(response);
}
