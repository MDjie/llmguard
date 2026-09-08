import { z } from 'zod';
import { nativeBindingSchema, nativeAssessmentSchema, type NativeBinding } from '@/contracts/http/native-multimodal';
import { mediaTransformPlanSchema, mediaTransformReceiptSchema } from '@/contracts/http/media-transform';
import { evidenceLocationSchema } from '@/contracts/http/multimodal-analysis';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { evaluateNativeAssessment } from './native-gate';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const location=z.object({evidenceId:z.string().min(1),location:evidenceLocationSchema}).strict();
export const outputRecheckSchema=z.object({
  originalBinding:nativeBindingSchema,derivedBinding:nativeBindingSchema,
  originalAction:z.enum(['ALLOW','WARN','BLOCK','REQUIRE_REVIEW','SAFE_RESPONSE','MASK','REWRITE']),
  originalDecisionDigest:hash,
  requiredLocations:z.array(location).max(1000),
  transformations:z.array(z.object({originalArtifactId:z.string().min(1),derivedArtifactId:z.string().min(1),
    plan:mediaTransformPlanSchema,receipt:mediaTransformReceiptSchema,
  }).strict()).max(8),
  assessment:nativeAssessmentSchema,
  auxiliaryActions:z.array(z.enum(['ALLOW','WARN','BLOCK','REQUIRE_REVIEW','SAFE_RESPONSE','MASK','REWRITE'])).min(1).max(100),
}).strict();
const qualification=z.object({
  tenantId:z.string().min(1),applicationId:z.string().min(1),bundleDigest:hash,
  transformerVersion:z.literal('guard-media-transform-1'),kind:z.enum(['IMAGE','AUDIO','VIDEO']),
  operations:z.array(z.enum(['MASK_REGION','MUTE_INTERVAL','KEEP_INTERVAL'])).min(1).max(3),
  toolchainDigest:hash,approvalRef:z.string().min(1),datasetDigest:hash,validUntil:z.iso.datetime(),status:z.literal('PASS'),
}).strict();
function sameContext(a:NativeBinding,b:NativeBinding){
 return a.direction==='OUTPUT_COMPLETE'&&b.direction==='OUTPUT_COMPLETE'&&a.tenantId===b.tenantId&&a.applicationId===b.applicationId&&
  a.bundleDigest===b.bundleDigest&&a.contextDigest===b.contextDigest&&canonicalJson(a.requiredRiskIds)===canonicalJson(b.requiredRiskIds);
}
/** Validation only. This does not sign or consume a business release permit. */
export function validateNativeOutputRecheck(raw:unknown,options:{nativeRegistry?:string;transformRegistry?:string;now?:number}={}){
 const input=outputRecheckSchema.parse(raw),now=options.now??Date.now();
 if(!sameContext(input.originalBinding,input.derivedBinding))throw new Error('OUTPUT_RECHECK_CONTEXT_CHANGED');
 if(['BLOCK','REQUIRE_REVIEW','SAFE_RESPONSE'].includes(input.originalAction))throw new Error('OUTPUT_ORIGINAL_CONSTRAINT_TERMINAL');
 if(input.auxiliaryActions.some(action=>!['ALLOW','WARN'].includes(action)))throw new Error('OUTPUT_AUXILIARY_RECHECK_FAILED');
 if(input.originalBinding.sources.length!==input.derivedBinding.sources.length)throw new Error('OUTPUT_SOURCE_COUNT_CHANGED');
 if(new Set(input.transformations.map(t=>t.originalArtifactId)).size!==input.transformations.length||
   new Set(input.transformations.map(t=>t.derivedArtifactId)).size!==input.transformations.length)throw new Error('OUTPUT_TRANSFORM_DUPLICATE');
 const transforming=['MASK','REWRITE'].includes(input.originalAction);
 if(transforming!==Boolean(input.transformations.length)||transforming!==Boolean(input.requiredLocations.length))throw new Error('OUTPUT_TRANSFORM_REQUIREMENTS_MISSING');
 const catalog=z.array(qualification).max(10000).parse(JSON.parse(options.transformRegistry??process.env.MEDIA_TRANSFORM_QUALIFICATIONS_JSON??'[]'));
 const matched=new Set<string>();
 for(let index=0;index<input.originalBinding.sources.length;index++){
  const source=input.originalBinding.sources[index],derived=input.derivedBinding.sources[index];
  const transform=input.transformations.find(item=>item.originalArtifactId===source.artifactId);
  if(!transform){if(canonicalJson(source)!==canonicalJson(derived))throw new Error('OUTPUT_UNINSPECTED_SOURCE_CHANGED');continue;}
  matched.add(transform.originalArtifactId);
  if(source.modality==='TEXT'||source.modality==='DOCUMENT'||source.modality!==derived.modality||transform.derivedArtifactId!==derived.artifactId||
    source.artifactId===derived.artifactId||source.sourceId===derived.sourceId||source.sha256!==transform.plan.sourceSha256||
    source.sha256!==transform.receipt.sourceSha256||derived.sha256!==transform.receipt.derivedSha256||derived.contentVersion!==derived.sha256||
    transform.plan.kind!==source.modality||transform.plan.decisionDigest!==input.originalDecisionDigest||
    sha256(canonicalJson(transform.plan))!==transform.receipt.planDigest)throw new Error('OUTPUT_TRANSFORM_SOURCE_MISMATCH');
  const candidates=catalog.filter(item=>item.tenantId===input.originalBinding.tenantId&&item.applicationId===input.originalBinding.applicationId&&item.bundleDigest===input.originalBinding.bundleDigest&&item.kind===source.modality&&item.transformerVersion===transform.receipt.transformerVersion&&
    item.toolchainDigest===transform.receipt.toolchainDigest&&Date.parse(item.validUntil)>now&&
    transform.plan.operations.every(op=>item.operations.includes(op.operation)));
  if(candidates.length!==1)throw new Error('OUTPUT_TRANSFORM_QUALITY_REQUIRED');
  const receipt=transform.receipt,crop=transform.plan.operations.find(op=>op.operation==='KEEP_INTERVAL');
  if(receipt.mediaType!==({IMAGE:'image/png',AUDIO:'audio/wav',VIDEO:'video/mp4'}[transform.plan.kind])||
    receipt.sourceStartMs!==(crop?.interval.startMs??0)||transform.plan.operations.some(op=>op.interval&&op.interval.endMs>receipt.sourceDurationMs)||
    Math.abs(receipt.derivedDurationMs-(crop?crop.interval.endMs-crop.interval.startMs:receipt.sourceDurationMs))>100||
    (source.modality==='IMAGE'&&(receipt.sourceDurationMs!==0||receipt.audioTracks!==0||receipt.videoTracks!==1))||
    (source.modality==='AUDIO'&&(receipt.audioTracks!==1||receipt.videoTracks!==0))||
    (source.modality==='VIDEO'&&receipt.videoTracks!==1))throw new Error('OUTPUT_TRANSFORM_RECEIPT_INVALID');
  const required=input.requiredLocations.filter(item=>item.location.artifactId===source.artifactId);
  if(!required.length||required.some(item=>item.location.sourceDigest!==source.sha256)||
    transform.plan.operations.some(op=>!required.some(item=>item.evidenceId===op.evidenceId)))throw new Error('OUTPUT_TRANSFORM_EVIDENCE_MISMATCH');
  for(const target of required){
   const loc=target.location;
   const covered=transform.plan.operations.some(op=>{
    if(op.evidenceId!==target.evidenceId)return false;
    if(op.operation==='KEEP_INTERVAL')return loc.startMs!==undefined&&loc.endMs!==undefined&&(loc.endMs<op.interval.startMs||loc.startMs>=op.interval.endMs);
    const timeCovered=source.modality==='IMAGE'||(loc.startMs!==undefined&&loc.endMs!==undefined&&op.interval&&op.interval.startMs<=loc.startMs&&op.interval.endMs>=loc.endMs);
    if(op.operation==='MUTE_INTERVAL')return (source.modality==='AUDIO'||(source.modality==='VIDEO'&&loc.channel!==undefined&&loc.region===undefined&&loc.frameIndex===undefined))&&Boolean(timeCovered);
    return Boolean(timeCovered)&&Boolean(loc.region)&&op.region[0]<=loc.region![0]&&op.region[1]<=loc.region![1]&&op.region[2]>=loc.region![2]&&op.region[3]>=loc.region![3];
   });
   if(!covered)throw new Error('OUTPUT_RISK_LOCATION_NOT_COVERED');
  }
 }
 if(matched.size!==input.transformations.length||input.requiredLocations.some(item=>!matched.has(item.location.artifactId)))throw new Error('OUTPUT_TRANSFORM_SOURCE_MISSING');
 const gate=evaluateNativeAssessment(input.derivedBinding,input.assessment,false,options.nativeRegistry,now);
 if(!gate.eligible)throw new Error('OUTPUT_NATIVE_RECHECK_NOT_QUALIFIED');
 return {version:'native-output-recheck-1' as const,originalBindingDigest:sha256(canonicalJson(input.originalBinding)),
  derivedBindingDigest:sha256(canonicalJson(input.derivedBinding)),assessmentDigest:sha256(canonicalJson(input.assessment)),
  transformationDigest:sha256(canonicalJson(input.transformations)),nativeQualification:gate.qualification,
  requiresFreshArchiveConfirmation:true,requiresOneTimeExecutionPermit:true};
}
