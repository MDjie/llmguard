import {z} from 'zod';
import {mediaAnnotationSchema,type MediaAnnotation} from '@/contracts/http/media-evidence';
export const authorizedMediaSchema=z.object({
 mimeType:z.enum(['image/png','image/jpeg','image/webp','image/gif','audio/wav','audio/x-wav','audio/mpeg','video/mp4']),
 dataBase64:z.string().min(4).max(1398104).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value=>value.length%4===0),
 annotations:z.array(mediaAnnotationSchema).max(100).optional(),
}).strict();
export type AuthorizedMedia=z.infer<typeof authorizedMediaSchema>;
/** The browser must verify both ends against the actual decoded duration before seeking. */
export function verifiedSeekSeconds(raw:unknown,duration:number):number|null{
 const parsed=mediaAnnotationSchema.safeParse(raw);
 if(!parsed.success||parsed.data.startMs===undefined||parsed.data.endMs===undefined||!Number.isFinite(duration)||duration<=0||parsed.data.endMs/1000>duration)return null;
 return parsed.data.startMs/1000;
}
export function activeMediaAnnotations(annotations:readonly MediaAnnotation[],timeSeconds:number):MediaAnnotation[]{
 if(!Number.isFinite(timeSeconds)||timeSeconds<0)return [];
 return annotations.filter(item=>item.startMs!==undefined&&item.endMs!==undefined&&timeSeconds*1000>=item.startMs&&timeSeconds*1000<=item.endMs);
}
