import type { EvidenceView } from '@/contracts/http/media-evidence';
import { and,asc,eq } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { artifactParts } from '@/storage/database/shared/schema';
import { scopePredicate } from '@/lib/tenancy';
import { readAcceptedTextArtifact } from '@/lib/artifacts';
import { claimNextGuardJob,completeGuardJob,failGuardJob,monitorGuardJobCancellation,isGuardJobCancellationError } from '@/lib/guard-jobs';
import { validateNativeJobBinding } from '@/lib/guard-jobs/native-binding';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle';
import { combineActionConstraints } from '@/lib/guard-engine-v2/action-constraints';
import { analyzeDocumentOrImage } from './analyzer';
import { analyzeAudioVideo } from '@/lib/media/analyzer';
import { fuseMultimodal } from './fusion';
import { fuseMediaTimeline } from '@/lib/media/timeline-fusion';
import { analyzeNativeArtifacts } from './native-analyzer';
import { runGlmJointEvidence } from './joint-evidence-judge';
import type { GuardAction } from '@guardllm/contracts';
export async function processNextNativeJointJob(){
 const job=await claimNextGuardJob(['native_joint']);if(!job)return null;
 const scope={tenantId:job.tenantId,applicationId:job.applicationId},monitor=monitorGuardJobCancellation(job);
 try{
  const initial=await validateNativeJobBinding(scope,job.ownerId,job.executionBinding),bundle=await loadVerifiedPolicyBundle(scope,job.bundleId);
  const userText=await readAcceptedTextArtifact(scope,initial.binding.contextArtifactId,131072,['TEXT'],monitor.signal);
  const inputs=await Promise.all(initial.artifacts.map(async artifact=>({artifact,parts:await db.select().from(artifactParts).where(and(scopePredicate(artifactParts,scope),eq(artifactParts.artifactId,artifact.id))).orderBy(asc(artifactParts.partNumber))})));
  const actions:GuardAction[]=[],evidence:unknown[]=[],coverage:unknown[]=[];
  const privateViews:EvidenceView[]=[],coordinateMappings:Record<string,unknown>[]=[];
  let auxiliaryDegraded=false;
  const auxiliaryReasons=new Set<string>();
  const context={...scope,direction:initial.binding.direction,traceId:'job-trace-'+job.id,absoluteDeadlineEpochMs:Date.now()+120000};
  // Each auxiliary branch retains its own action/evidence; a joint clean result never clears a branch denial or required review.
  for(const input of inputs){
   monitor.signal.throwIfAborted();
   if(input.artifact.kind==='IMAGE'){
    const analysis=await analyzeDocumentOrImage({...input,scope,signal:monitor.signal});
    const fused=await fuseMultimodal({bundle,context,userText,contextArtifactId:initial.binding.contextArtifactId,artifactSha256:input.artifact.verifiedSha256??undefined,analysisCoverage:analysis.coverage,
     ocr:analysis.ocr.map(item=>({...item,artifactId:input.artifact.id,artifactSha256:input.artifact.verifiedSha256??undefined})),codes:analysis.codes.map(item=>({...item,artifactId:input.artifact.id,artifactSha256:input.artifact.verifiedSha256??undefined})),
     visual:analysis.visual.map(item=>({...item,artifactId:input.artifact.id,artifactSha256:input.artifact.verifiedSha256??undefined})),analysisFailures:analysis.analysisFailures,sourceTrust:'UNTRUSTED',instructionCapability:'FORBIDDEN',anomalyScore:Math.max(0,...analysis.anomalies.map(item=>item.score))});
    privateViews.push(...fused.privateEvidenceViews);coordinateMappings.push(...(analysis.coordinateMappings??[]).map(mapping=>({...mapping,artifactId:input.artifact.id})));
    if(fused.degraded){for(const failure of analysis.analysisFailures)auxiliaryReasons.add(failure.code);if(!fused.coverage.complete)auxiliaryReasons.add(fused.coverage.reasonCode);if(!auxiliaryReasons.size)auxiliaryReasons.add('AUXILIARY_ANALYSIS_INCOMPLETE');}
    auxiliaryDegraded ||= fused.degraded; actions.push(fused.action);evidence.push(...fused.evidence);coverage.push({artifactId:input.artifact.id,analysisCoverage:analysis.coverage??null,fusionCoverage:fused.coverage});
   }else{
    const analysis=await analyzeAudioVideo({...input,scope,signal:monitor.signal});
    const fused=await fuseMediaTimeline({bundle,context,userText,contextArtifactId:initial.binding.contextArtifactId,artifactId:input.artifact.id,artifactSha256:input.artifact.verifiedSha256??undefined,analysisCoverage:analysis.coverage,
     segments:[...analysis.transcript.map(item=>({...item,viewId:item.sourceViewId,source:'audio' as const})),...analysis.subtitles.map(item=>({...item,source:'subtitle' as const})),...analysis.frames.flatMap(frame=>[...(frame.ocrText?[{source:'frame_ocr' as const,text:frame.ocrText,startMs:frame.timeMs,endMs:frame.timeMs,frameIndex:frame.frameIndex,viewId:'frame_'+frame.frameIndex}]:[]),...frame.codes.map(code=>({source:'qr_code' as const,text:code.text,confidence:code.confidence,startMs:frame.timeMs,endMs:frame.timeMs,frameIndex:frame.frameIndex,viewId:code.viewId}))])],
     visual:analysis.frames.flatMap(frame=>frame.risks.map(risk=>({...risk,timeMs:frame.timeMs,frameIndex:frame.frameIndex}))),analysisFailures:analysis.analysisFailures,sourceTrust:'UNTRUSTED',instructionCapability:'FORBIDDEN',anomalyScore:Math.max(0,...analysis.anomalies.map(item=>item.score))});
    privateViews.push(...fused.privateEvidenceViews);coordinateMappings.push(...(analysis.coordinateMappings??[]).map(mapping=>({...mapping,artifactId:input.artifact.id})));
    if(fused.degraded){for(const failure of analysis.analysisFailures)auxiliaryReasons.add(failure.code);if(!fused.coverage.complete)auxiliaryReasons.add(fused.coverage.reasonCode);if(!auxiliaryReasons.size)auxiliaryReasons.add('AUXILIARY_ANALYSIS_INCOMPLETE');}
    auxiliaryDegraded ||= fused.degraded; actions.push(fused.action);evidence.push(...fused.evidence);coverage.push({artifactId:input.artifact.id,analysisCoverage:analysis.coverage??null,fusionCoverage:fused.coverage,windowCoverage:fused.windowCoverage});
   }
  }
  const native=await analyzeNativeArtifacts({scope,bundlePayload:bundle.payload,requiredRiskIds:bundle.payload.semanticCoverage?.requiredRiskIds??[],direction:initial.binding.direction,contextText:userText,contextArtifactId:initial.binding.contextArtifactId,artifacts:inputs,signal:monitor.signal});
  const jointEvidence=native.binding?await runGlmJointEvidence({binding:native.binding,views:privateViews,privateOnly:true,absoluteDeadlineEpochMs:context.absoluteDeadlineEpochMs,signal:monitor.signal}):null;
  if(jointEvidence){actions.push(jointEvidence.action);if(jointEvidence.mode==='ENFORCE')evidence.push(...jointEvidence.evidence);if(jointEvidence.status==='UNKNOWN'&&jointEvidence.mode==='ENFORCE'){auxiliaryDegraded=true;for(const reason of jointEvidence.reasonCodes)auxiliaryReasons.add(reason);}}
  await validateNativeJobBinding(scope,job.ownerId,initial.binding);
  const action=combineActionConstraints([...actions,native.gate.action]).action;
  const eligible=native.gate.eligible&&['ALLOW','WARN'].includes(action);
  const degradationReasons=[...new Set([...auxiliaryReasons,...native.gate.reasonCodes])];
  await completeGuardJob(job,{contractVersion:'1.0',analysisContractVersion:'1.1',artifactId:job.artifactId,bundleId:job.bundleId,action,evidence,
   cooperativeAttack:native.gate.verdict==='CONFIRMED',crossModalVerdict:native.gate.verdict,nativeBinding:native.binding,nativeAssessment:native.assessment,nativeCoverage:native.gate,jointEvidence,relationSources:native.binding?.sources??[],relations:native.gate.relations,
   analysisCoverage:coverage,releaseEligibility:{eligible,executionPermitRequired:true,reasonCodes:eligible?[]:[...degradationReasons,...(!['ALLOW','WARN'].includes(action)?['ACTION_REQUIRES_INTERVENTION']:[])]},degraded:auxiliaryDegraded||!native.gate.qualified||native.gate.reasonCodes.length>0,degradationReasons},{views:privateViews,mappings:coordinateMappings});
  return{jobId:job.id,status:'completed'};
 }catch(error:unknown){if(monitor.signal.aborted||isGuardJobCancellationError(error))return{jobId:job.id,status:'cancelled'};await failGuardJob(job,error);return{jobId:job.id,status:job.attempt>=job.maxAttempts?'failed':'retrying'};}finally{monitor.stop();}
}
