import {pcmSchema} from '@/lib/media/formats/pcm';
import { z } from 'zod';

const boundedId = z.string().min(1).max(128);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const createArtifactUploadSchema = z.object({
  kind: z.enum(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'TOOL_RESULT', 'RAG_CHUNK']),
  fileName: z.string().trim().min(1).max(500),
  mediaType: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/),
  sizeBytes: z.number().int().positive().max(3_221_225_472),
  sha256,
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  retentionDays: z.number().int().min(1).max(365).default(7),
  metadata: z.record(z.string().max(100), z.union([z.string().max(1_000), z.number(), z.boolean(), z.null(), pcmSchema]))
    .refine((value) => Object.keys(value).length <= 50, 'metadata has too many entries')
    .refine(value => Object.entries(value).every(([key,item]) => item === null || typeof item !== 'object' || key === 'pcm'), 'Only pcm may contain structured metadata')
    .default({}),
}).strict();

export const artifactParamsSchema = z.object({ id: boundedId }).strict();
export const artifactPartParamsSchema = z.object({
  id: boundedId,
  partNumber: z.coerce.number().int().min(1).max(10_000),
}).strict();

export const completeArtifactUploadSchema = z.object({
  parts: z.array(z.object({
    partNumber: z.number().int().min(1).max(10_000),
    sizeBytes: z.number().int().positive().max(64 * 1_024 * 1_024),
    sha256,
    etag: z.string().trim().min(1).max(200).optional(),
  }).strict()).min(1).max(10_000),
}).strict();
