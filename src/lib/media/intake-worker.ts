import {makeEvidenceView} from '@/lib/evidence/media-views';
import {validateEvidenceLocation} from '@/lib/evidence/location';
import {createHash} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import type {GuardAction} from '@guardllm/contracts';
import type {EvidenceView} from '@/contracts/http/media-evidence';
import {db} from '@/storage/database/shared/db';
import {artifactParts} from '@/storage/database/shared/schema';
import {scopePredicate} from '@/lib/tenancy';
import {readAcceptedArtifactBytes} from '@/lib/artifacts/binary-reader';
import {decodeText} from './formats/text-decoder';
import {extensionOf} from './formats/registry';
import {parseSubtitleCues, subtitleCuesForRange} from './formats/subtitles';
import {isConfirmedObservation} from '@/lib/guard-engine-v2/observation-role';
import {createChunks} from '@/lib/document/parser';
import {claimNextGuardJob,completeGuardJob,failGuardJob,monitorGuardJobCancellation,isGuardJobCancellationError,updateGuardJobProgress} from '@/lib/guard-jobs';
import {validateIntakeBinding} from '@/lib/guard-jobs/intake-binding';
import {loadVerifiedPolicyBundle} from '@/lib/policy-bundle';
import {createEngineForPolicyBundle} from '@/lib/guard-engine-v2';
import {combineActionConstraints} from '@/lib/guard-engine-v2/action-constraints';
import {inspectRiskRelations,type RelationSource} from '@/lib/guard-engine-v2/risk-relations';
import {fusionSourceContent} from '@/lib/multimodal/source-content';
import {analyzeDocumentOrImage} from '@/lib/multimodal/analyzer';
import {fuseMultimodal} from '@/lib/multimodal/fusion';
import {analyzeAudioVideo} from './analyzer';
import {fuseMediaTimeline} from './timeline-fusion';
import {analyzeNativeArtifacts} from '@/lib/multimodal/native-analyzer';
import {runGlmJointEvidence} from '@/lib/multimodal/joint-evidence-judge';
import {persistNormalizedAsset} from '@/lib/artifacts/normalized';
import {projectDocument,projectMedia,projectText} from '@/lib/artifacts/normalized-projection';
import type {NormalizedAsset} from '@/lib/artifacts/normalized-contract';

/** All console file entry points use the same accepted-artifact and policy-bound job. */
export async function processNextIntakeJob(){
 const job=await claimNextGuardJob(['intake']);if(!job)return null;
 const scope={tenantId:job.tenantId,applicationId:job.applicationId},monitor=monitorGuardJobCancellation(job);
 const timeout=AbortSignal.timeout(30*60_000),signal=AbortSignal.any([monitor.signal,timeout]);
 try{
  const initial=await validateIntakeBinding(scope,job.ownerId,job.executionBinding),bundle=await loadVerifiedPolicyBundle(scope,job.bundleId);
  const textEvidenceKeys=new Set<string>();
  const actions:GuardAction[]=[],evidence:unknown[]=[],coverage:unknown[]=[],views:EvidenceView[]=[],mappings:Record<string,unknown>[]=[];
  const reasons=new Set<string>(),relations:RelationSource[]=[];
  const mediaInputs:Parameters<typeof analyzeNativeArtifacts>[0]['artifacts'][number][]=[];
  let textBudget=0;
  const normalizedAssets:NormalizedAsset[]=[];
  const context=()=>({...scope,direction:'INPUT' as const,taskPurpose:initial.binding.taskPurpose||undefined,traceId:'intake-'+job.id,absoluteDeadlineEpochMs:Date.now()+60_000});
  for(const [index,artifact] of initial.artifacts.entries()){
   signal.throwIfAborted();await updateGuardJobProgress(job,'analyzing_sources',5+index*75/initial.artifacts.length,{artifactId:artifact.id,sourceIndex:index});
   if(artifact.kind==='TEXT'){
    const bytes=await readAcceptedArtifactBytes(scope,artifact.id,50*1024*1024,['TEXT'],signal);
    const encoding=artifact.metadata?.encoding;
    if(encoding!==undefined&&!['utf-8','utf-16le','utf-16be','gb18030'].includes(String(encoding)))throw new Error('TEXT_ENCODING_INVALID');
    const decoded=decodeText(bytes,encoding as 'utf-8'|'utf-16le'|'utf-16be'|'gb18030'|undefined),chunks=createChunks(decoded.text,{maxChunkSize:8192,overlapSize:1024});
    if(!chunks.length)throw new Error('DOCUMENT_TEXT_EMPTY');
    if(chunks.length>512)reasons.add('TEXT_WINDOW_BUDGET_EXCEEDED');
    const subtitleExtension=extensionOf(artifact.fileName);
    const subtitle=['srt','vtt','ass','ssa'].includes(subtitleExtension)?parseSubtitleCues(decoded.text,subtitleExtension):null;
    subtitle?.reasonCodes.forEach(reason=>reasons.add(reason));
    if(subtitle)mappings.push({artifactId:artifact.id,mappingVersion:'subtitle-cue-to-decoded-text-1',offsetEncoding:'UTF16',cues:subtitle.cues});
    const decodedTextSha256=createHash('sha256').update(decoded.text).digest('hex');
    let complete=chunks.length<=512&&!subtitle?.reasonCodes.length;
    for(const chunk of chunks.slice(0,512)){
     signal.throwIfAborted();
     const ctx={...context(),requestId:'intake-'+job.id+'-'+index+'-'+chunk.index,policyBundleId:bundle.id,subjectId:job.ownerId};
     const content=fusionSourceContent(chunk.content,[{start:0,end:chunk.content.length,source:'file_text',artifactId:artifact.id}],ctx);
     const decision=await createEngineForPolicyBundle(bundle).evaluate({contractVersion:'1.0',context:ctx,content});
     actions.push(decision.action);if(decision.degraded||decision.degradationReasons.length){complete=false;decision.degradationReasons.forEach(reason=>reasons.add(reason));}
     const confirmed=decision.observations.filter(isConfirmedObservation);
     if(confirmed.some(item=>item.evidence.length)){
      const view=makeEvidenceView({artifactId:artifact.id,sourceDigest:artifact.verifiedSha256!,text:chunk.content,textLength:chunk.content.length,contentPath:'/text/chunks/'+chunk.index,viewId:'chunk-'+chunk.index,source:'file_text'});
      views.push(view);mappings.push({artifactId:artifact.id,viewId:view.viewId,mappingVersion:'decoded-text-window-1',offsetEncoding:'UTF16',globalStart:chunk.startOffset,globalEnd:chunk.endOffset,encoding:decoded.encoding,bomBytes:decoded.bomBytes,decodedTextSha256});
      for(const observation of confirmed)for(const ref of observation.evidence){
       const start=ref.start===undefined?undefined:ref.start+chunk.startOffset,end=ref.end===undefined?undefined:ref.end+chunk.startOffset;
       const key=JSON.stringify([artifact.id,observation.riskType,observation.detectorId,start,end,ref.contentHmac]);if(textEvidenceKeys.has(key))continue;textEvidenceKeys.add(key);
       const cues=start!==undefined&&end!==undefined&&subtitle?subtitleCuesForRange(subtitle.cues,start,end):[];
       const locatedViews=cues.length?cues.map(cue=>({...view,viewId:view.viewId+'-cue-'+cue.index,startMs:cue.startMs,endMs:cue.endMs})): [view];
       if(cues.length)views.push(...locatedViews);
       const locations=locatedViews.flatMap(locatedView=>{const {text:_text,source:_source,...position}=locatedView;void _text;void _source;const located=validateEvidenceLocation({...position,textStart:ref.start,textEnd:ref.end});return located.location?[located.location]:[];});
       evidence.push({...ref,evidenceRef:createHash('sha256').update(key).digest('hex'),riskType:observation.riskType,detectorId:observation.detectorId,detectorVersion:observation.detectorVersion,status:observation.status,decisionRole:observation.decisionRole,reasonCode:observation.reasonCode,score:observation.score,scoreMeaning:observation.scoreMeaning??'UNCALIBRATED',action:decision.action,artifactId:artifact.id,sourceDigest:artifact.verifiedSha256,decodedTextSha256,offsetEncoding:'UTF16',start,end,locationState:ref.start===undefined||!locations.length?'UNVERIFIED':'VERIFIED',locations:ref.start===undefined?[]:locations});
      }
     }

    }
    normalizedAssets.push(await persistNormalizedAsset(job,projectText({parentArtifactId:artifact.id,parentSha256:artifact.verifiedSha256!,sourceKind:'TEXT'},decoded.text,decoded.encoding),signal));
    coverage.push({artifactId:artifact.id,complete,encoding:decoded.encoding,expectedChunks:chunks.length,processedChunks:Math.min(chunks.length,512)});
    if(textBudget+decoded.text.length<=131072){relations.push({id:artifact.id,text:decoded.text,sourceType:'FILE',instructionCapability:'FORBIDDEN',objectRef:artifact.id});textBudget+=decoded.text.length;}else reasons.add('CROSS_SOURCE_TEXT_BUDGET_EXCEEDED');
    continue;
   }
   const parts=await db.select().from(artifactParts).where(and(scopePredicate(artifactParts,scope),eq(artifactParts.artifactId,artifact.id))).orderBy(asc(artifactParts.partNumber));
   const input={artifact,parts,scope,signal};mediaInputs.push({artifact,parts});
   if(artifact.kind==='IMAGE'||artifact.kind==='DOCUMENT'){
    const analysis=await analyzeDocumentOrImage(input);
    normalizedAssets.push(await persistNormalizedAsset(job,projectDocument({parentArtifactId:artifact.id,parentSha256:artifact.verifiedSha256!,sourceKind:artifact.kind},analysis),signal));
    const fused=await fuseMultimodal({bundle,context:context(),userText:initial.binding.taskPurpose,artifactSha256:artifact.verifiedSha256??undefined,analysisCoverage:analysis.coverage,
     documentText:analysis.documentText?.map(part=>({...part,artifactId:artifact.id,artifactSha256:artifact.verifiedSha256??undefined})),
      ocr:analysis.ocr.map(item=>({...item,artifactId:artifact.id,artifactSha256:artifact.verifiedSha256??undefined})),codes:analysis.codes.map(item=>({...item,artifactId:artifact.id,artifactSha256:artifact.verifiedSha256??undefined})),visual:analysis.visual.map(item=>({...item,artifactId:artifact.id,artifactSha256:artifact.verifiedSha256??undefined})),
     analysisFailures:analysis.analysisFailures,sourceTrust:'UNTRUSTED',instructionCapability:'FORBIDDEN',anomalyScore:Math.max(0,...analysis.anomalies.map(item=>item.score))});
    actions.push(fused.action);evidence.push(...fused.evidence);views.push(...fused.privateEvidenceViews);mappings.push(...(analysis.coordinateMappings??[]).map(item=>({...item,artifactId:artifact.id})));
    coverage.push({artifactId:artifact.id,analysisCoverage:analysis.coverage,fusionCoverage:fused.coverage,complete:!fused.degraded&&fused.coverage.complete});
    if(fused.degraded||!fused.coverage.complete){reasons.add('DOCUMENT_ANALYSIS_INCOMPLETE');analysis.analysisFailures.forEach(item=>reasons.add(item.code));}
   }else{
    const analysis=await analyzeAudioVideo(input);
    normalizedAssets.push(await persistNormalizedAsset(job,projectMedia({parentArtifactId:artifact.id,parentSha256:artifact.verifiedSha256!,sourceKind:artifact.kind==='AUDIO'?'AUDIO':'VIDEO'},analysis),signal));
    const fused=await fuseMediaTimeline({bundle,context:context(),userText:initial.binding.taskPurpose,artifactId:artifact.id,artifactSha256:artifact.verifiedSha256??undefined,analysisCoverage:analysis.coverage,
     segments:[...analysis.transcript.map(item=>({...item,viewId:item.sourceViewId,source:'audio' as const})),...analysis.subtitles.map(item=>({...item,viewId:item.sourceViewId,source:'subtitle' as const})),...analysis.frames.flatMap(frame=>[...(frame.ocrText?[{source:'frame_ocr' as const,text:frame.ocrText,startMs:frame.timeMs,endMs:frame.timeMs,frameIndex:frame.frameIndex,viewId:'frame_'+frame.frameIndex}]:[]),...frame.codes.map(code=>({source:'qr_code' as const,text:code.text,confidence:code.confidence,startMs:frame.timeMs,endMs:frame.timeMs,frameIndex:frame.frameIndex,viewId:code.viewId}))])],
     visual:analysis.frames.flatMap(frame=>frame.risks.map(risk=>({...risk,timeMs:frame.timeMs,frameIndex:frame.frameIndex}))),analysisFailures:analysis.analysisFailures,sourceTrust:'UNTRUSTED',instructionCapability:'FORBIDDEN',anomalyScore:Math.max(0,...analysis.anomalies.map(item=>item.score))});
    actions.push(fused.action);evidence.push(...fused.evidence);views.push(...fused.privateEvidenceViews);mappings.push(...(analysis.coordinateMappings??[]).map(item=>({...item,artifactId:artifact.id})));
    coverage.push({artifactId:artifact.id,analysisCoverage:analysis.coverage,fusionCoverage:fused.coverage,complete:!fused.degraded&&fused.coverage.complete});
    if(fused.degraded||!fused.coverage.complete){reasons.add('MEDIA_ANALYSIS_INCOMPLETE');analysis.analysisFailures.forEach(item=>reasons.add(item.code));}
   }
  }
  const mediaSourceIds=new Set(mediaInputs.map(input=>input.artifact.id));
  for(const view of views.filter(item=>item.source!=='file_text'||mediaSourceIds.has(item.artifactId))){if(textBudget+view.text.length>131072){reasons.add('CROSS_SOURCE_TEXT_BUDGET_EXCEEDED');break;}textBudget+=view.text.length;relations.push({id:'view-'+relations.length,text:view.text,sourceType:view.source==='file_text'?'FILE':'MEDIA',instructionCapability:'FORBIDDEN',objectRef:view.artifactId,startMs:view.startMs,endMs:view.endMs});}
  const relationAssessment=inspectRiskRelations(relations);if(relationAssessment.coverage!=='COMPLETE')relationAssessment.reasonCodes.forEach(reason=>reasons.add(reason));
  // Relations are evidence for adjudication; a keyword relationship alone never creates a confirmed block.
  let native=null,joint=null;
  if(mediaInputs.length){
   await updateGuardJobProgress(job,'joint_adjudication',85);
   const contextText=JSON.stringify({taskPurpose:initial.binding.taskPurpose,files:relations.filter(item=>item.sourceType==='FILE').map(({objectRef,text})=>({artifactId:objectRef,instructionCapability:'FORBIDDEN',text}))});
   native=await analyzeNativeArtifacts({scope,bundlePayload:bundle.payload,requiredRiskIds:bundle.payload.semanticCoverage?.requiredRiskIds??[],direction:'INPUT',contextText,artifacts:mediaInputs,signal});
   joint=native.binding?await runGlmJointEvidence({binding:native.binding,views:views.filter(item=>mediaSourceIds.has(item.artifactId)),privateOnly:true,absoluteDeadlineEpochMs:Date.now()+120000,signal}):null;
   if(joint){actions.push(joint.action);if(joint.mode==='ENFORCE')evidence.push(...joint.evidence);if(joint.mode==='ENFORCE'&&joint.status==='UNKNOWN')joint.reasonCodes.forEach(reason=>reasons.add(reason));}
   if(bundle.payload.semanticDecisionMode==='coverage-v1'||native.gate.qualified){actions.push(native.gate.action);if(!native.gate.eligible)native.gate.reasonCodes.forEach(reason=>reasons.add(reason));}
  }
  signal.throwIfAborted();await validateIntakeBinding(scope,job.ownerId,initial.binding);
  if(reasons.size)actions.push('REQUIRE_REVIEW');
  const action=combineActionConstraints(actions).action,eligible=!reasons.size&&['ALLOW','WARN'].includes(action);
  await completeGuardJob(job,{contractVersion:'1.0',analysisContractVersion:'intake-1',artifactId:job.artifactId,bundleId:job.bundleId,action,sourceBinding:initial.binding,analysisCoverage:coverage,evidence,
   normalizedAssets,relationAssessment:{...relationAssessment,evidence:relationAssessment.evidence},nativeBinding:native?.binding??null,nativeAssessment:native?.assessment??null,nativeCoverage:native?.gate??null,jointEvidence:joint,degraded:reasons.size>0,degradationReasons:[...reasons],operationalOutcome:reasons.size?'INCOMPLETE':action==='REQUIRE_REVIEW'?'REQUIRES_REVIEW':'COMPLETE',
   releaseEligibility:{eligible,executionPermitRequired:true,reasonCodes:eligible?[]:[...reasons,...(!['ALLOW','WARN'].includes(action)?['ACTION_REQUIRES_INTERVENTION']:[])]}},{views,mappings});
  return {jobId:job.id,status:'completed'};
 }catch(error:unknown){if(monitor.signal.aborted||isGuardJobCancellationError(error))return {jobId:job.id,status:'cancelled'};await failGuardJob(job,error);return {jobId:job.id,status:job.attempt>=job.maxAttempts?'failed':'retrying'};}finally{monitor.stop();}
}
