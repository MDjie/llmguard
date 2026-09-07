import { z } from 'zod';
import { and,eq } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { guardJobs } from '@/storage/database/shared/schema';
import { scopePredicate,type TenantScope } from '@/lib/tenancy';
import { nativeBindingSchema,nativeAssessmentSchema } from '@/contracts/http/native-multimodal';
import { validateNativeJobBinding } from '@/lib/guard-jobs/native-binding';
import { evaluateNativeAssessment } from '@/lib/multimodal/native-gate';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { canonicalJson,GatewayError,sha256 } from './protocol';
import { NATIVE_MEDIA_MAX_BYTES } from './native-content';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const nativeExecutionProofSchema=z.object({jobId:z.uuid(),jobDigest:hash,contextDigest:hash,modelRoute:z.string().min(1).max(128),routingDigest:hash,adapterDigest:hash}).strict();
const adapterSchema=z.object({tenantId:z.string(),applicationId:z.string(),modelRoute:z.string().min(1).max(128),routingDigest:hash,
 formatVersion:z.literal('chat-media-1'),modalities:z.array(z.enum(['IMAGE','AUDIO','VIDEO'])).min(1).max(3),maximumBytes:z.number().int().positive().max(NATIVE_MEDIA_MAX_BYTES),validUntil:z.iso.datetime(),approvalRef:z.string().min(1).max(128)}).strict();
const jobResultSchema=z.object({action:z.enum(['ALLOW','WARN']),nativeBinding:nativeBindingSchema,nativeAssessment:nativeAssessmentSchema,
 releaseEligibility:z.object({eligible:z.literal(true)}).loose()}).loose();
export async function validateNativeExecutionJob(input:TenantScope&{subjectId:string;bundleId:string;jobId:string;contextDigest:string;modelRoute:string;routingDigest:string;references:readonly{artifactId:string;sha256:string}[]}){
 const [job]=await db.select().from(guardJobs).where(and(scopePredicate(guardJobs,input),eq(guardJobs.ownerId,input.subjectId),eq(guardJobs.id,input.jobId),eq(guardJobs.jobType,'native_joint'),eq(guardJobs.status,'completed'))).limit(1);
 if(!job||job.bundleId!==input.bundleId||!job.completedAt||Date.now()-job.completedAt.getTime()>600000||job.completedAt.getTime()>Date.now()+1000)throw new GatewayError('NATIVE_EXECUTION_JOB_UNAVAILABLE',403);
 const result=jobResultSchema.safeParse(job.result);if(!result.success)throw new GatewayError('NATIVE_EXECUTION_REQUIRES_REVIEW',403);
 const current=await validateNativeJobBinding(input,input.subjectId,job.executionBinding),binding=result.data.nativeBinding;
 if(current.binding.direction!=='INPUT'||binding.direction!=='INPUT'||binding.tenantId!==input.tenantId||binding.applicationId!==input.applicationId||binding.contextDigest!==input.contextDigest||current.binding.contextSha256!==input.contextDigest)throw new GatewayError('NATIVE_EXECUTION_CONTEXT_MISMATCH',403);
 const refs=current.binding.artifacts.map(item=>({artifactId:item.id,sha256:item.sha256})),nativeRefs=binding.sources.filter(source=>source.modality!=='TEXT').map(source=>({artifactId:source.artifactId,sha256:source.sha256}));
 if(canonicalJson(refs)!==canonicalJson(input.references)||canonicalJson(nativeRefs)!==canonicalJson(refs))throw new GatewayError('NATIVE_EXECUTION_SOURCE_MISMATCH',403);
 const bundle=await loadVerifiedPolicyBundle(input,input.bundleId);
 if(binding.bundleDigest!==sha256(canonicalJson(bundle.payload))||canonicalJson([...binding.requiredRiskIds].sort())!==canonicalJson([...(bundle.payload.semanticCoverage?.requiredRiskIds??[])].sort()))throw new GatewayError('NATIVE_EXECUTION_POLICY_MISMATCH',403);
 const gate=evaluateNativeAssessment(binding,result.data.nativeAssessment);if(!gate.eligible)throw new GatewayError('NATIVE_EXECUTION_QUALIFICATION_INVALID',403);
 let adapters:z.infer<typeof adapterSchema>[];try{adapters=z.array(adapterSchema).max(1000).parse(JSON.parse(process.env.NATIVE_MEDIA_ROUTE_ADAPTERS_JSON??'[]'));}catch{throw new GatewayError('NATIVE_ROUTE_ADAPTER_INVALID',503);}
 const candidates=adapters.filter(adapter=>adapter.tenantId===input.tenantId&&adapter.applicationId===input.applicationId&&adapter.modelRoute===input.modelRoute&&adapter.routingDigest===input.routingDigest&&Date.parse(adapter.validUntil)>Date.now());
 if(candidates.length!==1||!current.binding.artifacts.every(item=>candidates[0].modalities.includes(item.kind)))throw new GatewayError('NATIVE_ROUTE_NOT_QUALIFIED',403);
 if(current.binding.artifacts.reduce((sum,item)=>sum+item.sizeBytes,0)>candidates[0].maximumBytes)throw new GatewayError('NATIVE_MEDIA_BUDGET_EXCEEDED',413);
 return nativeExecutionProofSchema.parse({jobId:job.id,jobDigest:sha256(canonicalJson(job.result)),contextDigest:input.contextDigest,modelRoute:input.modelRoute,routingDigest:input.routingDigest,adapterDigest:sha256(canonicalJson(candidates[0]))});
}
