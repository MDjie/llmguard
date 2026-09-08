import { describe,it,expect } from 'vitest';
import { validateNativeOutputRecheck } from '@/lib/multimodal/output-recheck';
import { mediaTransformPlanSchema } from '@/contracts/http/media-transform';
import { nativeBindingDigest,nativeCombination } from '@/lib/multimodal/native-gate';
import { canonicalJson,sha256 } from '@/lib/gateway-runtime/protocol';
import type { NativeBinding } from '@/contracts/http/native-multimodal';

const original:NativeBinding={version:'1.0',tenantId:'tenant',applicationId:'app',bundleDigest:'b'.repeat(64),direction:'OUTPUT_COMPLETE',contextDigest:sha256('caption'),
 requiredRiskIds:['prompt_injection'],sources:[{sourceId:'original',artifactId:'original',sha256:'a'.repeat(64),contentVersion:'a'.repeat(64),modality:'IMAGE'}]};
const derived:NativeBinding={...original,sources:[{sourceId:'derived',artifactId:'derived',sha256:'c'.repeat(64),contentVersion:'c'.repeat(64),modality:'IMAGE'}]};
const plan=mediaTransformPlanSchema.parse({version:'media-transform-1',sourceSha256:'a'.repeat(64),decisionDigest:'d'.repeat(64),kind:'IMAGE',
 operations:[{operation:'MASK_REGION',region:[0,0,1,1],evidenceId:'sensitive'}]});
const assessment={version:'1.0',bindingDigest:nativeBindingDigest(derived),modelId:'synthetic-native',modelDigest:'e'.repeat(64),analyzerVersion:'test',verdict:'NOT_DETECTED',riskIds:[],
 analyzedSourceIds:['derived'],coverageScope:'GLOBAL',processingComplete:true,relations:[],reasonCodes:[]};
const input={originalBinding:original,derivedBinding:derived,originalAction:'MASK',originalDecisionDigest:plan.decisionDigest,
 requiredLocations:[{evidenceId:'sensitive',location:{artifactId:'original',sourceDigest:'a'.repeat(64),contentVersion:'a'.repeat(64),contentPath:'/image',mappingVersion:'guard-evidence-location-1',offsetEncoding:'UTF16',region:[0.2,0.2,0.8,0.8]}}],
 transformations:[{originalArtifactId:'original',derivedArtifactId:'derived',plan,receipt:{version:'media-transform-1',planDigest:sha256(canonicalJson(plan)),sourceSha256:'a'.repeat(64),
 derivedSha256:'c'.repeat(64),mediaType:'image/png',sizeBytes:128,transformerVersion:'guard-media-transform-1',toolchainDigest:'f'.repeat(64),sourceDurationMs:0,derivedDurationMs:0,
 sourceStartMs:0,width:64,height:64,audioTracks:0,videoTracks:1,decodeVerified:true,semanticRecheckRequired:true}}],assessment,auxiliaryActions:['ALLOW','WARN']};
const nativeRegistry=JSON.stringify([{tenantId:'tenant',applicationId:'app',bundleDigest:original.bundleDigest,direction:'OUTPUT_COMPLETE',modelId:assessment.modelId,modelDigest:assessment.modelDigest,
 analyzerVersion:'test',combination:nativeCombination(derived),requiredRiskIds:['prompt_injection'],coverageScope:'GLOBAL',datasetDigest:'1'.repeat(64),approvalRef:'engineering-only',validUntil:'2099-01-01T00:00:00.000Z',status:'PASS'}]);
const transformRegistry=JSON.stringify([{tenantId:'tenant',applicationId:'app',bundleDigest:original.bundleDigest,transformerVersion:'guard-media-transform-1',kind:'IMAGE',operations:['MASK_REGION'],toolchainDigest:'f'.repeat(64),
 approvalRef:'engineering-only',datasetDigest:'2'.repeat(64),validUntil:'2099-01-01T00:00:00.000Z',status:'PASS'}]);
const options={nativeRegistry,transformRegistry};
describe('native output reinspection constraints',()=>{
 it('binds the new object and requires a separate archive confirmation and execution permit',()=>{
  expect(validateNativeOutputRecheck(input,options)).toMatchObject({requiresFreshArchiveConfirmation:true,requiresOneTimeExecutionPermit:true});
 });
 it.each(['BLOCK','REQUIRE_REVIEW','SAFE_RESPONSE'])('does not clear the original %s constraint',action=>{
  expect(()=>validateNativeOutputRecheck({...input,originalAction:action},options)).toThrow('CONSTRAINT_TERMINAL');
 });
 it('rejects reusing original identity, old-model results, INPUT direction and route-context substitutes',()=>{
  expect(()=>validateNativeOutputRecheck({...input,assessment:{...assessment,bindingDigest:nativeBindingDigest(original)}},options)).toThrow('NOT_QUALIFIED');
  expect(()=>validateNativeOutputRecheck({...input,derivedBinding:{...derived,direction:'INPUT'}},options)).toThrow('CONTEXT_CHANGED');
  expect(()=>validateNativeOutputRecheck({...input,derivedBinding:{...derived,contextDigest:'9'.repeat(64)}},options)).toThrow('CONTEXT_CHANGED');
  expect(()=>validateNativeOutputRecheck({...input,derivedBinding:original},options)).toThrow('SOURCE_MISMATCH');
 });
 it('requires all risk locations, all auxiliary branches and current scoped quality approval',()=>{
  const otherLocation={...input.requiredLocations[0],evidenceId:'other'};
  expect(()=>validateNativeOutputRecheck({...input,requiredLocations:[...input.requiredLocations,otherLocation]},options)).toThrow('NOT_COVERED');
  expect(()=>validateNativeOutputRecheck({...input,auxiliaryActions:['REQUIRE_REVIEW']},options)).toThrow('AUXILIARY');
  expect(()=>validateNativeOutputRecheck(input,{...options,transformRegistry:'[]'})).toThrow('QUALITY_REQUIRED');
  expect(()=>validateNativeOutputRecheck(input,{...options,nativeRegistry:'[]'})).toThrow('NOT_QUALIFIED');
 });
 it('cannot manufacture a media clearance from GLM-derived evidence or a decoder receipt alone',()=>{
  expect(()=>validateNativeOutputRecheck({...input,assessment:{...assessment,processingComplete:false}},options)).toThrow('NOT_QUALIFIED');
  expect(()=>validateNativeOutputRecheck({...input,assessment:{status:'COMPLETE',modelId:'glm-5.3',inputMode:'DERIVED_EVIDENCE'}},options)).toThrow();
  expect(()=>validateNativeOutputRecheck({...input,transformations:[]},options)).toThrow('REQUIREMENTS_MISSING');
 });
});
