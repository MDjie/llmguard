import { z } from 'zod';
import { evidenceLocationSchema } from './multimodal-analysis';
export const evidenceViewSchema = evidenceLocationSchema.safeExtend({
 text:z.string().max(262144),source:z.string().min(1).max(128),
}).strict();
export type EvidenceView = z.infer<typeof evidenceViewSchema>;
export const reviewEvidenceSchema=z.object({evidenceId:z.string().min(1).max(128),polarity:z.enum(['SUPPORT','COUNTER']),riskType:z.string().max(128),detectorId:z.string().max(128),modelVersion:z.string().max(256).optional(),decisionRole:z.string().max(64),reasonCode:z.string().max(128),locations:z.array(evidenceLocationSchema).min(1).max(1000)}).strict();
export type ReviewEvidence=z.infer<typeof reviewEvidenceSchema>;
export const reviewHighlightSchema=reviewEvidenceSchema.omit({riskType:true,locations:true}).extend({modelVersion:z.string().max(256),label:z.string(),parts:z.array(z.object({start:z.number().int(),end:z.number().int(),text:z.string(),evidenceIds:z.array(z.string())}).strict())}).strict();
export const evidenceSnapshotSchema=z.object({version:z.literal('media-evidence-1'),jobId:z.uuid(),bundleId:z.string().min(1),
 reviewEvidence:z.array(reviewEvidenceSchema).max(10000).optional(),views:z.array(evidenceViewSchema).max(10000),mappings:z.array(z.record(z.string(),z.unknown())).max(10000),
}).strict();
export const mediaEvidenceMetadataSchema=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),jobId:z.uuid(),state:z.enum(['PENDING','OBJECT_WRITTEN','READY','DELETE_PENDING','DELETED']),
 sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),holdUntil:z.iso.datetime().nullable(),errorCode:z.string().nullable()}).strict();

export const mediaAnnotationSchema=z.object({evidenceId:z.string().min(1).max(128),label:z.string().max(512),region:z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)]).optional(),startMs:z.number().int().nonnegative().optional(),endMs:z.number().int().nonnegative().optional()}).strict().superRefine((value,context)=>{
 if((value.startMs===undefined)!==(value.endMs===undefined)||(value.startMs!==undefined&&value.endMs!<value.startMs))context.addIssue({code:'custom',message:'Invalid annotation interval'});
 if(value.region&&(value.region[2]<=value.region[0]||value.region[3]<=value.region[1]))context.addIssue({code:'custom',message:'Invalid annotation rectangle'});
});
export type MediaAnnotation=z.infer<typeof mediaAnnotationSchema>;
export const mediaProvenanceSchema=z.object({version:z.literal('media-source-provenance-1'),jobId:z.uuid(),artifactId:z.string(),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),views:z.array(evidenceLocationSchema).max(10000),mappings:z.array(z.record(z.string(),z.unknown())).max(10000)}).strict();
