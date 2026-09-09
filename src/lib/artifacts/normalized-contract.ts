import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/gateway-runtime/protocol';
import { analysisCoverageSchema } from '@/contracts/http/multimodal-analysis';

export const NORMALIZED_VERSION = 'normalized-text-1';
export const NORMALIZED_MAX_BYTES = 32 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const normalizedSegmentSchema = z.object({
  text: z.string().max(262144), source: z.enum(['DECODED_TEXT', 'DOCUMENT_TEXT', 'OCR', 'CODE', 'ASR', 'SUBTITLE', 'FRAME_OCR']),
  viewId: z.string().min(1).max(128), containerPath: z.string().max(500).optional(),
  page: z.number().int().positive().optional(), region: z.array(z.number().nonnegative()).length(4).optional(),
  startMs: z.number().int().nonnegative().optional(), endMs: z.number().int().nonnegative().optional(),
  frameIndex: z.number().int().nonnegative().optional(), channel: z.number().int().nonnegative().max(64).optional(),
}).strict().refine(value => (value.startMs === undefined) === (value.endMs === undefined) &&
  (value.startMs === undefined || value.endMs! >= value.startMs), 'Invalid source interval');
export const normalizedDocumentSchema = z.object({
  version: z.literal(NORMALIZED_VERSION), parentArtifactId: z.uuid(), parentSha256: digest,
  transformVersion: z.string().min(1).max(512), sourceKind: z.enum(['TEXT', 'DOCUMENT', 'IMAGE', 'AUDIO', 'VIDEO']),
  representation: z.literal('TEXT_PROJECTION'), nativeCoverageClaimed: z.literal(false), instructionCapability: z.literal('FORBIDDEN'),
  segments: z.array(normalizedSegmentSchema).max(100000),
  coverage: analysisCoverageSchema.nullable(), complete: z.boolean(), reasonCodes: z.array(z.string().min(1).max(200)).max(200),
  coordinateMappings: z.array(z.record(z.string(), z.unknown())).max(10000),
}).strict().superRefine((value, context) => {
  if (value.coverage && (value.coverage.artifactSha256 !== value.parentSha256 || value.coverage.modality !== value.sourceKind)) {
    context.addIssue({ code: 'custom', message: 'Coverage source mismatch' });
  }
  if (value.complete && (value.reasonCodes.length || (value.sourceKind !== 'TEXT' &&
    (!value.coverage || value.coverage.state !== 'COMPLETE' || value.coverage.processedUnits !== value.coverage.expectedUnits || value.coverage.reasonCodes.length)))) {
    context.addIssue({ code: 'custom', message: 'Incomplete projection cannot claim complete coverage' });
  }
});
export type NormalizedDocument = z.infer<typeof normalizedDocumentSchema>;
export type NormalizedSegment = z.infer<typeof normalizedSegmentSchema>;
export const normalizedAssetSchema = z.object({
  version: z.literal(NORMALIZED_VERSION), artifactId: z.uuid(), sha256: digest, parentArtifactId: z.uuid(), parentSha256: digest,
  transformVersion: z.string().min(1).max(512), representation: z.literal('TEXT_PROJECTION'),
  state: z.literal('READY'), complete: z.boolean(), nativeCoverageClaimed: z.literal(false),
}).strict();
export type NormalizedAsset = z.infer<typeof normalizedAssetSchema>;

export function encodeNormalizedDocument(raw: unknown): { document: NormalizedDocument; bytes: Buffer; sha256: string } {
  const document = normalizedDocumentSchema.parse(raw);
  const bytes = Buffer.from(canonicalJson(JSON.parse(JSON.stringify(document))));
  if (bytes.length > NORMALIZED_MAX_BYTES) throw new Error('NORMALIZED_ASSET_BUDGET_EXCEEDED');
  return { document, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Offsets refer to this exact projected text, never to the original file bytes. */
export function normalizedText(document: NormalizedDocument) {
  let offset = 0;
  const mappings = document.segments.map((segment, index) => {
    const start = offset; offset += segment.text.length + (index < document.segments.length - 1 && segment.source !== 'DECODED_TEXT' ? 1 : 0);
    const { text, ...source } = segment;
    return { ...source, segment: index, textStart: start, textEnd: start + text.length, offsetEncoding: 'UTF16' as const };
  });
  return { text: document.segments.map((segment, index) => segment.text + (index < document.segments.length - 1 && segment.source !== 'DECODED_TEXT' ? '\n' : '')).join(''), mappings };
}
