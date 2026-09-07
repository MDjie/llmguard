import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {validateNativeExecutionJob} from '@/lib/gateway-runtime/native-execution';
import {canonicalJson,sha256} from '@/lib/gateway-runtime/protocol';
import {nativeBindingDigest,nativeCombination} from '@/lib/multimodal/native-gate';
import type {NativeBinding,NativeAssessment} from '@/contracts/http/native-multimodal';
const fixture=vi.hoisted(()=>({job:{} as Record<string,unknown>,binding:{} as unknown,payload:{semanticCoverage:{requiredRiskIds:['prompt_injection']}}}));
vi.mock('@/storage/database/shared/db',()=>({db:{select:()=>({from:()=>({where:()=>({limit:async()=>[fixture.job]})})})}}));
vi.mock('@/lib/guard-jobs/native-binding',()=>({validateNativeJobBinding:async()=>({binding:fixture.binding})}));
vi.mock('@/lib/policy-bundle',()=>({loadVerifiedPolicyBundle:async()=>({payload:fixture.payload})}));
const request={tenantId:'tenant',applicationId:'app',subjectId:'owner',bundleId:'bundle',jobId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',contextDigest:'c'.repeat(64),modelRoute:'route',routingDigest:'d'.repeat(64),references:[{artifactId:'image',sha256:'e'.repeat(64)}]};
const binding:NativeBinding={version:'1.0',tenantId:'tenant',applicationId:'app',bundleDigest:sha256(canonicalJson(fixture.payload)),direction:'INPUT',contextDigest:request.contextDigest,requiredRiskIds:['prompt_injection'],sources:[{sourceId:'context',artifactId:'context',sha256:request.contextDigest,modality:'TEXT',contentVersion:'1'},{sourceId:'image',artifactId:'image',sha256:request.references[0].sha256,modality:'IMAGE',contentVersion:'1'}]};
const assessment:NativeAssessment={version:'1.0',bindingDigest:nativeBindingDigest(binding),modelId:'synthetic-joint',modelDigest:'f'.repeat(64),analyzerVersion:'test',verdict:'NOT_DETECTED',riskIds:[],analyzedSourceIds:['context','image'],coverageScope:'GLOBAL',processingComplete:true,relations:[],reasonCodes:[]};
beforeEach(()=>{
 fixture.job={id:request.jobId,bundleId:request.bundleId,completedAt:new Date(),executionBinding:{},result:{action:'ALLOW',nativeBinding:binding,nativeAssessment:assessment,releaseEligibility:{eligible:true}}};
 fixture.binding={direction:'INPUT',contextSha256:request.contextDigest,artifacts:[{id:'image',sha256:request.references[0].sha256,kind:'IMAGE',sizeBytes:5}]};
 vi.stubEnv('NATIVE_MULTIMODAL_QUALIFICATIONS_JSON',JSON.stringify([{tenantId:'tenant',applicationId:'app',bundleDigest:binding.bundleDigest,direction:'INPUT',modelId:assessment.modelId,modelDigest:assessment.modelDigest,analyzerVersion:'test',combination:nativeCombination(binding),requiredRiskIds:['prompt_injection'],coverageScope:'GLOBAL',datasetDigest:'1'.repeat(64),approvalRef:'synthetic-engineering-only',validUntil:'2099-01-01T00:00:00.000Z',status:'PASS'}]));
 vi.stubEnv('NATIVE_MEDIA_ROUTE_ADAPTERS_JSON',JSON.stringify([{tenantId:'tenant',applicationId:'app',modelRoute:'route',routingDigest:request.routingDigest,formatVersion:'chat-media-1',modalities:['IMAGE'],maximumBytes:1048576,validUntil:'2099-01-01T00:00:00.000Z',approvalRef:'synthetic-engineering-only'}]));
});
afterEach(()=>vi.unstubAllEnvs());
describe('native execution binding and live revocation',()=>{
 it('binds an eligible result to the current request, source and exact route configuration',async()=>{expect(await validateNativeExecutionJob(request)).toMatchObject({jobId:request.jobId,contextDigest:request.contextDigest,routingDigest:request.routingDigest});});
 it('denies changed context, ordered sources, bundle, direction and expired jobs',async()=>{
  await expect(validateNativeExecutionJob({...request,contextDigest:'2'.repeat(64)})).rejects.toThrow('CONTEXT_MISMATCH');
  await expect(validateNativeExecutionJob({...request,references:[{artifactId:'other',sha256:request.references[0].sha256}]})).rejects.toThrow('SOURCE_MISMATCH');
  await expect(validateNativeExecutionJob({...request,bundleId:'other'})).rejects.toThrow('JOB_UNAVAILABLE');
  fixture.job.completedAt=new Date(Date.now()-600001);await expect(validateNativeExecutionJob(request)).rejects.toThrow('JOB_UNAVAILABLE');
 });
 it('requires live route and detector qualifications despite a saved clean job',async()=>{
  await expect(validateNativeExecutionJob({...request,routingDigest:'3'.repeat(64)})).rejects.toThrow('ROUTE_NOT_QUALIFIED');
  vi.stubEnv('NATIVE_MULTIMODAL_QUALIFICATIONS_JSON','[]');await expect(validateNativeExecutionJob(request)).rejects.toThrow('QUALIFICATION_INVALID');
 });
 it('never authorizes review, transform or blocked auxiliary branch results',async()=>{for(const action of ['BLOCK','REQUIRE_REVIEW','MASK','REWRITE']){fixture.job.result={action,nativeBinding:binding,nativeAssessment:assessment,releaseEligibility:{eligible:true}};await expect(validateNativeExecutionJob(request)).rejects.toThrow('REQUIRES_REVIEW');}});
});
