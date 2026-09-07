import { alertFeedbackReviewDigest } from './feedback';
import { selectCandidateText } from './candidate-text';
export { selectCandidateText } from './candidate-text';
import { z } from 'zod';
import { and,eq,gt,asc,inArray } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { securityAlerts,badcaseFeedback,badcaseFeedbackReviews,contentAccessRequests,archivedContentObjects,mediaEvidenceSnapshots,feedbackCandidateExports } from '@/storage/database/shared/schema';
import { scopePredicate,type TenantContext } from '@/lib/tenancy';
import { canonicalJson,sha256 } from '@/lib/gateway-runtime/protocol';
import { prepareDataset } from '@/lib/evaluation/dataset-workbench';
import { detectionCaseSchema } from '@/lib/evaluation/optimization-dataset';
import { maskPII } from '@/lib/guardrail/pii-masker';
import { redactText } from '@/lib/observability/logger';
import { consumeMediaEvidence } from '@/lib/evidence/media-snapshots';
import { consumeArchivedContentAccess } from '@/lib/conversation-archive/access';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import type { ArchiveObjectStore } from '@/lib/conversation-archive/object-store';
export const feedbackCandidateInputSchema=z.object({feedbackId:z.uuid(),resourceType:z.enum(['MEDIA_EVIDENCE','ARCHIVED_CONTENT']),resourceId:z.string().regex(/^[a-f0-9]{64}$/),accessRequestId:z.uuid(),
 selector:z.string().min(1).max(512).default('MATCHED_EVIDENCE'),licenseRef:z.string().min(1).max(128),origin:z.enum(['customer','synthetic']).default('customer')}).strict();
type Input=z.infer<typeof feedbackCandidateInputSchema>;
type Transaction=Parameters<Parameters<typeof db.transaction>[0]>[0];
async function approvedSource(reader:Pick<typeof db,'select'>,scope:TenantContext,alertId:string,input:Input){
 const [alert]=await reader.select().from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.id,alertId))).limit(1);
 if(!alert)throw new Error('FEEDBACK_ALERT_UNAVAILABLE');
 const [feedback]=await reader.select().from(badcaseFeedback).where(and(scopePredicate(badcaseFeedback,scope),eq(badcaseFeedback.id,input.feedbackId),eq(badcaseFeedback.decisionId,alert.decisionId),eq(badcaseFeedback.riskType,alert.riskId),eq(badcaseFeedback.status,'triaged'))).limit(1).for('share');
 const [review]=await reader.select().from(badcaseFeedbackReviews).where(and(scopePredicate(badcaseFeedbackReviews,scope),eq(badcaseFeedbackReviews.feedbackId,input.feedbackId),eq(badcaseFeedbackReviews.decision,'ACCEPT'))).limit(1);
 if(!feedback||!review||review.submittedBy===review.reviewedBy||review.submittedBy!==feedback.reviewerId)throw new Error('INDEPENDENT_FEEDBACK_TRIAGE_REQUIRED');
 if(alertFeedbackReviewDigest(feedback)!==review.sourceDigest)throw new Error('CANDIDATE_REVIEW_SOURCE_CHANGED');
 const [grant]=await reader.select().from(contentAccessRequests).where(and(scopePredicate(contentAccessRequests,scope),eq(contentAccessRequests.id,input.accessRequestId),eq(contentAccessRequests.resourceType,input.resourceType),eq(contentAccessRequests.resourceId,input.resourceId),eq(contentAccessRequests.requesterId,scope.principalId),eq(contentAccessRequests.purpose,'FALSE_POSITIVE_APPEAL'))).limit(1);
 if(!grant)throw new Error('CANDIDATE_SOURCE_GRANT_REQUIRED');
 if(input.resourceType==='MEDIA_EVIDENCE'){
  const [source]=await reader.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.id,input.resourceId))).limit(1);
  if(!source||source.jobId!==alert.jobId)throw new Error('CANDIDATE_SOURCE_ALERT_MISMATCH');
 }else{
  const [source]=await reader.select().from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects,scope),eq(archivedContentObjects.id,input.resourceId))).limit(1);
  if(!source||source.requestId!==alert.requestId||alert.stage.startsWith('INPUT')!==['RECEIVED_INPUT','MODEL_INPUT'].includes(source.purpose))throw new Error('CANDIDATE_SOURCE_ALERT_MISMATCH');
 }
 return {alert,feedback,review,grant};
}
export async function createFeedbackCandidate(scope:TenantContext,alertId:string,raw:Input,store?:ArchiveObjectStore){
 const input=feedbackCandidateInputSchema.parse(raw);await approvedSource(db,scope,alertId,input);
 let output:{candidateId:string;workbench:ReturnType<typeof prepareDataset>}|undefined;
 const exportCandidate=async(tx:Transaction,payload:{answerEvidence:string;sourceDigest:string;highlightViews:readonly {parts:readonly {text:string}[]}[]})=>{
  const {alert,feedback,review,grant}=await approvedSource(tx,scope,alertId,input);if(payload.sourceDigest!==grant.sourceDigest)throw new Error('CANDIDATE_SOURCE_CHANGED');
  const original=selectCandidateText(payload.answerEvidence,input.selector,payload.highlightViews),text=maskPII(redactText(original)).maskedText;
  const sourceId=sha256(canonicalJson([scope.tenantId,scope.applicationId,input.resourceType,input.resourceId])),caseId=sha256(canonicalJson([input.feedbackId,sourceId,input.selector]));
  const candidate=detectionCaseSchema.parse({caseId,groupId:sourceId,sourceId,sourceGroupId:sourceId,sourceLicense:'INTERNAL_FEEDBACK:'+input.licenseRef,sourceHash:sha256(original),split:'development',text,
   direction:alert.stage,modality:'text',expectedRiskIds:feedback.expectedAction==='ALLOW'?[]:[alert.riskId],acceptableActions:[feedback.expectedAction],familyTags:['feedback',feedback.classification,'derived_text_candidate',...(text!==original?['redacted_requires_review']:[])],annotationStatus:'needs_review',reviewers:[],authorizedExternalUse:false});
  const workbench=prepareDataset([candidate],input.origin,scope.principalId),candidateId=sha256(canonicalJson([scope.tenantId,scope.applicationId,input.accessRequestId,workbench.digest]));
  await tx.insert(feedbackCandidateExports).values({...scope,id:candidateId,feedbackId:input.feedbackId,grantId:input.accessRequestId,resourceType:input.resourceType,resourceId:input.resourceId,sourceDigest:payload.sourceDigest,candidateDigest:workbench.digest,createdBy:scope.principalId});
  await appendAuditEventInTransaction(tx,{...scope,event:'security.feedback.candidate.export',outcome:'ALLOWED',status:200,requestId:candidateId,traceId:alert.traceId,method:'INTERNAL',path:'/feedback/candidate',queryString:'candidateDigest='+workbench.digest+'&reviewDigest='+review.sourceDigest,latencyMs:0});output={candidateId,workbench};
 };
 if(input.resourceType==='MEDIA_EVIDENCE')await consumeMediaEvidence(scope,input.resourceId,input.accessRequestId,store,exportCandidate);else await consumeArchivedContentAccess(scope,input.resourceId,input.accessRequestId,store,exportCandidate);
 if(!output)throw new Error('CANDIDATE_EXPORT_NOT_COMMITTED');return output;
}

export async function listFeedbackCandidateSources(scope:TenantContext,alertId:string,afterId?:string){
 const [alert]=await db.select().from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.id,alertId))).limit(1);
 if(!alert)throw new Error('FEEDBACK_ALERT_UNAVAILABLE');
 const items:{id:string;resourceType:'MEDIA_EVIDENCE'|'ARCHIVED_CONTENT';sourceDigest:string;label:string}[]=[];
 if(!afterId&&alert.jobId){const media=await db.select().from(mediaEvidenceSnapshots).where(and(scopePredicate(mediaEvidenceSnapshots,scope),eq(mediaEvidenceSnapshots.jobId,alert.jobId),eq(mediaEvidenceSnapshots.state,'READY'))).limit(1);for(const row of media)items.push({id:row.id,resourceType:'MEDIA_EVIDENCE',sourceDigest:row.contentHmac,label:'媒体派生文本'});}
 const rows=alert.requestId?await db.select().from(archivedContentObjects).where(and(scopePredicate(archivedContentObjects,scope),eq(archivedContentObjects.requestId,alert.requestId),inArray(archivedContentObjects.state,['MANIFEST_COMMITTED','INDEXED']),inArray(archivedContentObjects.purpose,alert.stage.startsWith('INPUT')?['RECEIVED_INPUT','MODEL_INPUT']:['MODEL_OUTPUT','RELEASED_OUTPUT']),afterId?gt(archivedContentObjects.id,afterId):undefined)).orderBy(asc(archivedContentObjects.id)).limit(26):[];
 items.push(...rows.slice(0,25).map(row=>({id:row.id,resourceType:'ARCHIVED_CONTENT' as const,sourceDigest:row.contentHmac,label:row.purpose+' · '+row.representation+' · '+row.sequence})));
 return {items,hasMore:rows.length>25,nextAfterId:rows.length>25?rows[24].id:null};
}
