import {z} from 'zod';
import {and,eq,inArray} from 'drizzle-orm';
import {db} from '@/storage/database/shared/db';
import {artifacts} from '@/storage/database/shared/schema';
import {scopePredicate,type TenantScope} from '@/lib/tenancy';
import {MAX_ATTACHMENTS,MAX_ATTACHMENT_TOTAL_BYTES} from '@/lib/media/formats/registry';
export const intakeBindingSchema=z.object({version:z.literal('intake-1'),taskPurpose:z.string().max(4096),
  context:z.object({artifactId:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
  artifacts:z.array(z.object({id:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),kind:z.enum(['TEXT','DOCUMENT','IMAGE','AUDIO','VIDEO']),mediaType:z.string(),sizeBytes:z.number().int().positive()}).strict()).min(1).max(MAX_ATTACHMENTS)}).strict();
export async function captureIntakeBinding(scope:TenantScope,ownerId:string,ids:readonly string[],taskPurpose='',contextArtifactId?:string){
  if(!ids.length||ids.length>MAX_ATTACHMENTS||new Set(ids).size!==ids.length)throw new Error('INTAKE_SOURCE_IDS_INVALID');
  const rows=await db.select().from(artifacts).where(and(scopePredicate(artifacts,scope),eq(artifacts.ownerId,ownerId),eq(artifacts.state,'accepted'),inArray(artifacts.id,[...ids])));
  if(rows.length!==ids.length||rows.some(row=>row.contentExpiresAt.getTime()<=Date.now()))throw new Error('INTAKE_SOURCE_UNAVAILABLE');
  const ordered=ids.map(id=>rows.find(row=>row.id===id)!);
  const [context]=contextArtifactId ? await db.select().from(artifacts).where(and(scopePredicate(artifacts,scope),eq(artifacts.ownerId,ownerId),eq(artifacts.id,contextArtifactId))) : [];
  if(contextArtifactId && (!context || context.kind!=='TEXT' || context.state!=='accepted' || !context.verifiedSha256 || !context.verifiedSize || context.verifiedSize>256*1024 || context.contentExpiresAt<=new Date()))throw new Error('INTAKE_CONTEXT_UNAVAILABLE');
  const binding=intakeBindingSchema.parse({version:'intake-1',taskPurpose,...(context?{context:{artifactId:context.id,sha256:context.verifiedSha256}}:{}),artifacts:ordered.map(row=>({id:row.id,sha256:row.verifiedSha256,kind:row.kind,mediaType:row.detectedMediaType,sizeBytes:row.verifiedSize}))});
  if(binding.artifacts.reduce((sum,item)=>sum+item.sizeBytes,0)>MAX_ATTACHMENT_TOTAL_BYTES)throw new Error('INTAKE_TOTAL_BYTES_EXCEEDED');
  return {binding,artifacts:ordered};
}
export async function validateIntakeBinding(scope:TenantScope,ownerId:string,raw:unknown){
 const binding=intakeBindingSchema.parse(raw),current=await captureIntakeBinding(scope,ownerId,binding.artifacts.map(item=>item.id),binding.taskPurpose,binding.context?.artifactId);
 if(JSON.stringify(current.binding)!==JSON.stringify(binding))throw new Error('INTAKE_SOURCE_CHANGED');
 return current;
}
