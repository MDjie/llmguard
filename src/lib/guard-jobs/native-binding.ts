import { z } from 'zod';
import { and,eq,inArray } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { artifacts } from '@/storage/database/shared/schema';
import { scopePredicate,type TenantScope } from '@/lib/tenancy';
export const nativeJobBindingSchema=z.object({version:z.literal('native-job-1'),direction:z.enum(['INPUT','OUTPUT_COMPLETE','OUTPUT_CHUNK','TOOL_RESULT']),contextArtifactId:z.string(),contextSha256:z.string().regex(/^[a-f0-9]{64}$/),
 artifacts:z.array(z.object({id:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),kind:z.enum(['IMAGE','AUDIO','VIDEO']),mediaType:z.string(),sizeBytes:z.number().int().positive()}).strict()).min(1).max(8)}).strict();
export async function captureNativeJobBinding(scope:TenantScope,ownerId:string,artifactIds:readonly string[],contextArtifactId:string,direction:z.infer<typeof nativeJobBindingSchema>['direction']='INPUT'){
 if(!artifactIds.length||artifactIds.length>8||new Set(artifactIds).size!==artifactIds.length||artifactIds.includes(contextArtifactId))throw new Error('NATIVE_JOB_SOURCE_IDS_INVALID');
 const rows=await db.select().from(artifacts).where(and(scopePredicate(artifacts,scope),eq(artifacts.ownerId,ownerId),eq(artifacts.state,'accepted'),inArray(artifacts.id,[...artifactIds,contextArtifactId])));
 if(rows.length!==artifactIds.length+1||rows.some(row=>row.contentExpiresAt.getTime()<=Date.now()))throw new Error('NATIVE_JOB_SOURCE_UNAVAILABLE');
 const context=rows.find(row=>row.id===contextArtifactId)!;if(context.kind!=='TEXT'||!context.verifiedSha256)throw new Error('NATIVE_JOB_CONTEXT_INVALID');
 const binding=nativeJobBindingSchema.parse({version:'native-job-1',direction,contextArtifactId,contextSha256:context.verifiedSha256,artifacts:artifactIds.map(id=>{const row=rows.find(item=>item.id===id)!;return{id,sha256:row.verifiedSha256,kind:row.kind,mediaType:row.detectedMediaType,sizeBytes:row.verifiedSize};})});
 return {binding,artifacts:artifactIds.map(id=>rows.find(row=>row.id===id)!)};
}
export async function validateNativeJobBinding(scope:TenantScope,ownerId:string,raw:unknown){
 const binding=nativeJobBindingSchema.parse(raw),current=await captureNativeJobBinding(scope,ownerId,binding.artifacts.map(item=>item.id),binding.contextArtifactId,binding.direction);
 if(JSON.stringify(current.binding)!==JSON.stringify(binding))throw new Error('NATIVE_JOB_SOURCE_CHANGED');return current;
}
