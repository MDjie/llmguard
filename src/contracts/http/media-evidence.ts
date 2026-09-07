import { z } from 'zod';
import { evidenceLocationSchema } from './multimodal-analysis';
export const evidenceViewSchema = evidenceLocationSchema.safeExtend({
 text:z.string().max(262144),source:z.string().min(1).max(128),
}).strict();
export type EvidenceView = z.infer<typeof evidenceViewSchema>;
export const evidenceSnapshotSchema=z.object({version:z.literal('media-evidence-1'),jobId:z.uuid(),bundleId:z.string().min(1),
 views:z.array(evidenceViewSchema).max(10000),mappings:z.array(z.record(z.string(),z.unknown())).max(10000),
}).strict();
export const mediaEvidenceMetadataSchema=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),jobId:z.uuid(),state:z.enum(['PENDING','OBJECT_WRITTEN','READY','DELETE_PENDING','DELETED']),
 sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),holdUntil:z.iso.datetime().nullable(),errorCode:z.string().nullable()}).strict();

export const mediaAnnotationSchema=z.object({evidenceId:z.string().min(1).max(128),label:z.string().max(512),region:z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)]).optional(),startMs:z.number().int().nonnegative().optional(),endMs:z.number().int().nonnegative().optional()}).strict();
export type MediaAnnotation=z.infer<typeof mediaAnnotationSchema>;
export const mediaProvenanceSchema=z.object({version:z.literal('media-source-provenance-1'),jobId:z.uuid(),artifactId:z.string(),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),views:z.array(evidenceLocationSchema).max(10000),mappings:z.array(z.record(z.string(),z.unknown())).max(10000)}).strict();
