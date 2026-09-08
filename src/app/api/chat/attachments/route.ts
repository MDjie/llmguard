import {z} from 'zod';
import {and,eq,inArray} from 'drizzle-orm';
import {withApiSecurity,ApiProblem} from '@/lib/api-security';
import {jsonObjectResponseSchema} from '@/contracts/http/common';
import {consoleMessageSchema} from '@/contracts/http/gateway-chat';
import {db} from '@/storage/database/shared/db';
import {artifacts,applicationPolicyBindings,llmProviders} from '@/storage/database/shared/schema';
import {requireTenantContext,scopePredicate} from '@/lib/tenancy';
import {submitGuardJob} from '@/lib/guard-jobs';
import {storeVerifiedBytes} from '@/lib/artifacts/server-upload';
import {canonicalJson,sha256} from '@/lib/gateway-runtime/protocol';
const schema=z.object({providerId:z.string().min(1).max(36),messages:z.array(consoleMessageSchema).min(1).max(100),artifactIds:z.array(z.string().uuid()).min(1).max(8).refine(ids=>new Set(ids).size===ids.length),idempotencyKey:z.string().regex(/^[a-zA-Z0-9._:-]{8,100}$/)}).strict();
export const POST=withApiSecurity({permission:'guard:use',bodySchema:schema,responseSchema:jsonObjectResponseSchema,maxBodyBytes:256*1024,auditEvent:'chat.attachments.prepare',rateLimitPolicy:{id:'chat-attachments',windowMs:60000,maxRequests:30,scope:'principal'}},async({body,principal,request})=>{
 const scope=requireTenantContext(principal),ownerId=principal!.subject;
 const rows=await db.select().from(artifacts).where(and(scopePredicate(artifacts,scope),eq(artifacts.ownerId,ownerId),eq(artifacts.state,'accepted'),inArray(artifacts.id,body.artifactIds)));
 if(rows.length!==body.artifactIds.length||rows.some(row=>!row.verifiedSha256||row.contentExpiresAt<=new Date()))throw new ApiProblem({status:422,code:'CHAT_ATTACHMENTS_UNAVAILABLE',title:'附件不可用',detail:'请完成文件上传验证后重试。'});
 const ordered=body.artifactIds.map(id=>rows.find(row=>row.id===id)!);
 const references=ordered.map(row=>({artifactId:row.id,sha256:row.verifiedSha256!}));
 if(ordered.every(row=>row.kind==='TEXT'))return Response.json({success:true,data:{mode:'TEXT',references}});
 const [provider]=await db.select({id:llmProviders.id}).from(llmProviders).where(and(scopePredicate(llmProviders,scope),eq(llmProviders.id,body.providerId),eq(llmProviders.isEnabled,true))).limit(1);
 const [binding]=await db.select().from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings,scope)).limit(1);
 if(!provider||!binding?.activeBundleId)throw new ApiProblem({status:409,code:'CHAT_APPLICATION_NOT_READY',title:'应用尚未就绪',detail:'请配置目标模型并发布应用策略。'});
 const native=ordered.every(row=>['IMAGE','AUDIO','VIDEO'].includes(row.kind));
 if(!native){
  const submitted=await submitGuardJob({scope,ownerId,artifactId:ordered[0].id,sourceArtifactIds:body.artifactIds,taskPurpose:body.messages.findLast(message=>message.role==='user')?.content.slice(0,4096),bundleId:binding.activeBundleId,jobType:'intake',idempotencyKey:body.idempotencyKey,maxAttempts:2});
  return Response.json({success:true,data:{mode:'INSPECTION',jobId:submitted.job.id,references,releaseReason:'CHAT_DERIVED_ROUTE_QUALIFICATION_REQUIRED'}},{status:202});
 }
 // This is the exact business request excluding guard_artifacts, as checked by the gateway.
 const context=Buffer.from(canonicalJson({model:body.providerId,messages:body.messages,stream:false}));
 const stored=await storeVerifiedBytes({scope,ownerId,kind:'TEXT',fileName:'chat-context.json',mediaType:'application/json',bytes:context,idempotencyKey:'chat-context-'+sha256(body.idempotencyKey+':'+context.toString('utf8')),signal:request.signal});
 const submitted=await submitGuardJob({scope,ownerId,artifactId:ordered[0].id,nativeArtifactIds:body.artifactIds,contextArtifactId:stored.id,direction:'INPUT',bundleId:binding.activeBundleId,jobType:'native_joint',idempotencyKey:body.idempotencyKey,maxAttempts:2});
 return Response.json({success:true,data:{mode:'NATIVE',jobId:submitted.job.id,references:references.map(ref=>({...ref,jobId:submitted.job.id}))}},{status:202});
});
