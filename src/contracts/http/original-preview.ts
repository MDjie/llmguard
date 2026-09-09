import {z} from 'zod';
import {mediaAnnotationSchema} from './media-evidence';
export const ORIGINAL_MEDIA_MAX_BYTES=16*1024*1024;
export const ORIGINAL_PDF_MAX_BYTES=256*1024*1024;
export const ORIGINAL_PAGE_MAX=2000;
export const originalResourceIdSchema=z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:(?:0|[1-9][0-9]{0,3})$/).refine(value=>Number(value.split(':')[2])<=ORIGINAL_PAGE_MAX);
export function parseOriginalResourceId(value:string){const parts=originalResourceIdSchema.parse(value).split(':');return {snapshotId:parts[0],artifactId:parts[1],page:Number(parts[2])};}
export const originalMimeSchema=z.enum(['image/png','image/jpeg','image/webp','image/gif','audio/wav','audio/x-wav','audio/mpeg','video/mp4']);
export const originalMediaSchema=z.object({mimeType:originalMimeSchema,dataBase64:z.string().min(4).max(4*Math.ceil(ORIGINAL_MEDIA_MAX_BYTES/3)).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value=>value.length%4===0),annotations:z.array(mediaAnnotationSchema).max(100).optional()}).strict();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const originalPreviewSchema=z.object({version:z.literal('original-preview-1'),artifactId:z.uuid(),sourceSha256:hash,representation:z.enum(['ORIGINAL_BYTES','PDF_PAGE']),
 page:z.number().int().min(0).max(ORIGINAL_PAGE_MAX),totalPages:z.number().int().min(1).max(ORIGINAL_PAGE_MAX),transformVersion:z.enum(['original-bytes-1','pdf-page-raster-1']),outputSha256:hash,toolchainDigest:hash.optional(),media:originalMediaSchema,
}).strict().superRefine((value,ctx)=>{
 if(value.representation==='PDF_PAGE'?(value.page<1||value.page>value.totalPages||value.media.mimeType!=='image/png'||value.transformVersion!=='pdf-page-raster-1'):(value.page!==0||value.totalPages!==1||value.transformVersion!=='original-bytes-1'||value.sourceSha256!==value.outputSha256))ctx.addIssue({code:'custom',message:'Preview representation mismatch'});
});
export type OriginalPreview=z.infer<typeof originalPreviewSchema>;
export const originalSourceSchema=z.object({artifactId:z.uuid(),kind:z.enum(['DOCUMENT','IMAGE','AUDIO','VIDEO']),mimeType:z.string().max(128),sizeBytes:z.number().int().positive(),suggestedPages:z.array(z.number().int().min(1).max(ORIGINAL_PAGE_MAX)).max(100)}).strict();
export const originalSourcesResponseSchema=z.object({items:z.array(originalSourceSchema).max(8)}).strict();
