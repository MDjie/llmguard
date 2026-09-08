import { z } from 'zod';

const count = z.number().int().nonnegative();
export const mediaIntervalSchema = z.object({ startMs: count, endMs: count }).strict()
  .refine(value => value.endMs >= value.startMs, 'Invalid media interval');
export const processingUnitSchema = z.object({
  unit: z.enum(['PAGE_VIEW', 'FRAME', 'AUDIO_TRACK', 'SUBTITLE_TRACK', 'MILLISECOND']),
  expected: count, processed: count, failed: count, skipped: count,
}).strict().refine(value => value.processed + value.failed + value.skipped <= value.expected, 'Unit counts exceed expected');

export const audioTrackExecutionSchema=z.object({
 track:count.max(64),channel:count.max(64),sourceStartMs:count,sampleRate:count.positive(),sampleCount:count.positive(),durationMs:count.positive(),
 views:z.array(z.object({viewId:z.string().min(1).max(128),expectedIntervals:z.array(mediaIntervalSchema).max(10000),processedIntervals:z.array(mediaIntervalSchema).max(10000),state:z.enum(['COMPLETE','PARTIAL','FAILED']),modelVersions:z.array(z.string().min(1).max(128)).max(16)}).strict()).max(8),
 classifierComplete:z.boolean(),observedSpeechIntervals:z.array(mediaIntervalSchema).max(10000),
}).strict();

/** Optional v1.1 facts extend the existing analyzer response without reinterpreting SAMPLED. */
export const analysisCoverageSchema = z.object({
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u), modality: z.enum(['IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO']),
  state: z.enum(['COMPLETE', 'SAMPLED', 'INCOMPLETE']), expectedUnits: count.positive(), processedUnits: count,
  analyzerVersion: z.string().min(1).max(512), reasonCodes: z.array(z.string().min(1)).max(100),
  unit: z.enum(['PAGE_VIEW', 'MILLISECOND']).optional(),
  processingCoverage: z.array(processingUnitSchema).max(16).optional(),
  audioProcessing:z.array(audioTrackExecutionSchema).max(16).optional(),
  temporalCoverage: z.object({
    durationMs: count, processedIntervals: z.array(mediaIntervalSchema).max(10000),
    sampledAtMs: z.array(count).max(10000), maximumGapMs: count,
    enumerationComplete: z.boolean(),
    expectedAudioIntervals:z.array(mediaIntervalSchema).max(16).optional(),
    observedSpeechIntervals:z.array(mediaIntervalSchema).max(10000).optional(),
    processingBasis:z.literal('DECODED_SAMPLES_AND_PROVIDER_RECEIPTS').optional(),
  }).strict().optional(),
}).strict().refine(value => value.processedUnits <= value.expectedUnits, 'Processed units exceed expected');
export type AnalysisCoverage = z.infer<typeof analysisCoverageSchema>;

export const evidenceLocationSchema = z.object({
  artifactId: z.string().min(1).max(128), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  contentVersion: z.string().min(1).max(128), contentPath: z.string().min(1).max(512),
  mappingVersion: z.literal('guard-evidence-location-1'), offsetEncoding: z.literal('UTF16'),
  viewId: z.string().min(1).max(128).optional(),
  textStart: count.optional(), textEnd: count.optional(), textLength: count.optional(),
  page: count.positive().optional(),
  region: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  startMs: count.optional(), endMs: count.optional(), frameIndex: count.optional(),
  channel: count.max(64).optional(), speakerId: z.string().max(128).optional(),
}).strict().superRefine((value, context) => {
  if ((value.textStart === undefined) !== (value.textEnd === undefined) ||
    (value.textStart !== undefined && (value.textEnd! <= value.textStart || value.textLength === undefined || value.textEnd! > value.textLength))) {
    context.addIssue({ code: 'custom', message: 'Invalid text range' });
  }
  if ((value.startMs === undefined) !== (value.endMs === undefined) || (value.startMs !== undefined && value.endMs! < value.startMs)) {
    context.addIssue({ code: 'custom', message: 'Invalid media range' });
  }
  if (value.region && (value.region[2] < value.region[0] || value.region[3] < value.region[1])) context.addIssue({ code: 'custom', message: 'Invalid region' });
});
export type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;
