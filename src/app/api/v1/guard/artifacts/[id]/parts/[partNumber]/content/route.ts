import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {withApiSecurity,ApiProblem,readBodyBytesWithLimit} from '@/lib/api-security';
import {artifactPartParamsSchema} from '@/contracts/http/artifacts';
import {jsonObjectResponseSchema} from '@/contracts/http/common';
import {signArtifactPart} from '@/lib/artifacts/service';
import {requireTenantContext,scopePredicate} from '@/lib/tenancy';
import {db} from '@/storage/database/shared/db';
import {artifacts} from '@/storage/database/shared/schema';
/** Same-origin relay avoids exposing internal object-store endpoints to browsers. */
export const PUT=withApiSecurity({permission:'guard:use',paramsSchema:artifactPartParamsSchema,responseSchema:jsonObjectResponseSchema,
  allowedRequestMediaTypes:['application/octet-stream'],maxBodyBytes:16*1024**2,auditEvent:'artifact.part.upload',
  rateLimitPolicy:{id:'artifact-part-content',windowMs:60000,maxRequests:120,scope:'principal'}},
async({request,principal,routeContext})=>{
  const {id,partNumber}=artifactPartParamsSchema.parse(await (routeContext as {params:Promise<unknown>}).params);
  const scope=requireTenantContext(principal);
  const [artifact]=await db.select().from(artifacts).where(and(scopePredicate(artifacts,scope),eq(artifacts.id,id),eq(artifacts.ownerId,principal!.subject),eq(artifacts.state,'uploading'))).limit(1);
  if(!artifact || artifact.contentExpiresAt<=new Date() || partNumber>artifact.partCount) throw new ApiProblem({status:409,code:'GRD_ARTIFACT_NOT_UPLOADABLE',title:'上传不可用',detail:'文件不存在、已过期或状态已改变。'});
  const expected=partNumber===artifact.partCount?artifact.declaredSize-(partNumber-1)*artifact.partSize:artifact.partSize;
  const bytes=await readBodyBytesWithLimit(request,expected);
  if(bytes.length!==expected) throw new ApiProblem({status:422,code:'GRD_ARTIFACT_PART_SIZE_MISMATCH',title:'分片长度不符',detail:'请重试此分片。'});
  const digest=createHash('sha256').update(bytes).digest();
  const signed=await signArtifactPart(scope,principal!.subject,artifact.id,partNumber,digest.toString('base64'));
  const response=await fetch(signed.url,{method:'PUT',headers:signed.headers,body:Buffer.from(bytes),redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(60000)])});
  await response.body?.cancel();
  if(!response.ok && response.status!==412) throw new ApiProblem({status:502,code:'OBJECT_STORE_UPLOAD_FAILED',title:'存储写入失败',detail:'请稍后重试。'});
  // Existing immutable parts are rechecked against this digest by the final verifier.
  return Response.json({success:true,data:{partNumber,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}});
});
