import {z} from 'zod';
import {withApiSecurity,ApiProblem} from '@/lib/api-security';
import {jsonObjectResponseSchema} from '@/contracts/http/common';
import {requireTenantContext} from '@/lib/tenancy';
import {loadLatestVerifiedPolicyBundleForPolicy} from '@/lib/policy-bundle';
import {submitGuardJob,GuardJobError} from '@/lib/guard-jobs';
const schema=z.object({policyId:z.string().min(1).max(128),artifactIds:z.array(z.uuid()).min(1).max(8),taskPurpose:z.string().max(4096).default(''),idempotencyKey:z.string().regex(/^[a-zA-Z0-9._:-]{8,128}$/)}).strict();
export const POST=withApiSecurity({permission:'guard:use',bodySchema:schema,responseSchema:jsonObjectResponseSchema,maxBodyBytes:16384,auditEvent:'media.intake.submit',rateLimitPolicy:{id:'media-intake',windowMs:60000,maxRequests:30,scope:'principal'}},async({body,principal})=>{
 const scope=requireTenantContext(principal),bundle=await loadLatestVerifiedPolicyBundleForPolicy(scope,body.policyId,{routingKey:principal!.subject});
 try{const result=await submitGuardJob({scope,ownerId:principal!.subject,artifactId:body.artifactIds[0],sourceArtifactIds:body.artifactIds,taskPurpose:body.taskPurpose,bundleId:bundle.id,jobType:'intake',idempotencyKey:body.idempotencyKey,maxAttempts:2});return Response.json({success:true,data:result.job},{status:result.reused?200:202});}
 catch(error:unknown){if(error instanceof GuardJobError)throw new ApiProblem({status:422,code:error.code,title:'附件检测任务未创建',detail:error.message});throw error;}
});
