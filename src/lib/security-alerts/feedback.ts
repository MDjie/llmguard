import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { badcaseFeedback, badcaseFeedbackReviews, securityAlerts } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantContext } from '@/lib/tenancy';
import { ApiProblem } from '@/lib/api-security';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { alertActionSchema } from '@/contracts/http/security-alerts';
export const alertFeedbackSchema=z.object({expectedAction:alertActionSchema,classification:z.enum(['FALSE_POSITIVE','FALSE_NEGATIVE','WRONG_EXPLANATION','WRONG_ACTION']),reason:z.string().trim().min(10).max(500)}).strict();
export async function submitAlertFeedback(scope:TenantContext,alertId:string,raw:z.infer<typeof alertFeedbackSchema>){
 const input=alertFeedbackSchema.parse(raw);
 return db.transaction(async tx=>{
  const [alert]=await tx.select().from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.id,alertId))).for('share');
  if(!alert)throw new ApiProblem({status:404,code:'ALERT_NOT_FOUND',title:'Alert unavailable',detail:'The alert does not exist in this application.'});
  const requestHash=sha256(canonicalJson({version:'alert-feedback-1',tenantId:scope.tenantId,applicationId:scope.applicationId,alertId,actor:scope.principalId,input}));
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestHash},0))`);
  const [existing]=await tx.select({id:badcaseFeedback.id,status:badcaseFeedback.status}).from(badcaseFeedback).where(and(scopePredicate(badcaseFeedback,scope),eq(badcaseFeedback.requestHash,requestHash))).limit(1);
  if(existing)return {id:existing.id,created:false,status:existing.status,activationStatus:'NOT_PUBLISHED' as const};
  const [created]=await tx.insert(badcaseFeedback).values({tenantId:scope.tenantId,applicationId:scope.applicationId,requestHash,decisionId:alert.decisionId,riskType:alert.riskId,
   predictedAction:alert.action,expectedAction:input.expectedAction,evidenceHmacs:[...new Set(alert.evidence.flatMap(e=>e.contentHmac?[e.contentHmac]:[]))],classification:input.classification.toLowerCase(),status:'open',reviewerId:scope.principalId,disposition:input.reason}).returning({id:badcaseFeedback.id});
  return {id:created.id,created:true,status:'open' as const,activationStatus:'NOT_PUBLISHED' as const};
 });
}

export const feedbackReviewSchema = z.object({ feedbackId:z.uuid(), decision:z.enum(['ACCEPT','REJECT']), reason:z.string().trim().min(10).max(500) }).strict();
export async function listAlertFeedback(scope:TenantContext, alertId:string) {
 const [alert]=await db.select().from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.id,alertId))).limit(1);
 if(!alert)throw new ApiProblem({status:404,code:'ALERT_NOT_FOUND',title:'Alert unavailable',detail:'The alert is unavailable.'});
 return db.select({id:badcaseFeedback.id,submittedBy:badcaseFeedback.reviewerId,classification:badcaseFeedback.classification,expectedAction:badcaseFeedback.expectedAction,predictedAction:badcaseFeedback.predictedAction,status:badcaseFeedback.status,reason:badcaseFeedback.disposition,createdAt:badcaseFeedback.createdAt,reviewedBy:badcaseFeedbackReviews.reviewedBy,reviewDecision:badcaseFeedbackReviews.decision,reviewReason:badcaseFeedbackReviews.reason})
 .from(badcaseFeedback).leftJoin(badcaseFeedbackReviews,and(scopePredicate(badcaseFeedbackReviews,scope),eq(badcaseFeedbackReviews.feedbackId,badcaseFeedback.id)))
 .where(and(scopePredicate(badcaseFeedback,scope),eq(badcaseFeedback.decisionId,alert.decisionId),eq(badcaseFeedback.riskType,alert.riskId))).orderBy(badcaseFeedback.createdAt,badcaseFeedback.id).limit(100);
}
export async function reviewAlertFeedback(scope:TenantContext,alertId:string,raw:z.infer<typeof feedbackReviewSchema>){
 const input=feedbackReviewSchema.parse(raw);
 return db.transaction(async tx=>{
  const [alert]=await tx.select().from(securityAlerts).where(and(scopePredicate(securityAlerts,scope),eq(securityAlerts.id,alertId))).limit(1);
  const [feedback]=alert?await tx.select().from(badcaseFeedback).where(and(scopePredicate(badcaseFeedback,scope),eq(badcaseFeedback.id,input.feedbackId),eq(badcaseFeedback.decisionId,alert.decisionId),eq(badcaseFeedback.riskType,alert.riskId))).for('update'):[];
  const fail=(code:string)=>new ApiProblem({status:409,code,title:'Feedback review unavailable',detail:code});
  if(!feedback||!feedback.reviewerId)throw fail('FEEDBACK_NOT_AVAILABLE');
  if(feedback.reviewerId===scope.principalId)throw fail('INDEPENDENT_REVIEW_REQUIRED');
  const [existing]=await tx.select().from(badcaseFeedbackReviews).where(and(scopePredicate(badcaseFeedbackReviews,scope),eq(badcaseFeedbackReviews.feedbackId,feedback.id))).limit(1);
  if(existing){if(existing.reviewedBy===scope.principalId&&existing.decision===input.decision&&existing.reason===input.reason)return {id:feedback.id,status:feedback.status,activationStatus:'NOT_PUBLISHED' as const};throw fail('FEEDBACK_ALREADY_REVIEWED');}
  if(feedback.status!=='open')throw fail('FEEDBACK_ALREADY_REVIEWED');
  await tx.insert(badcaseFeedbackReviews).values({...scope,feedbackId:feedback.id,submittedBy:feedback.reviewerId,reviewedBy:scope.principalId,decision:input.decision,reason:input.reason,sourceDigest:alertFeedbackReviewDigest(feedback)});
  const status=input.decision==='ACCEPT'?'triaged':'rejected';
  await tx.update(badcaseFeedback).set({status,resolvedAt:input.decision==='REJECT'?new Date():null}).where(and(scopePredicate(badcaseFeedback,scope),eq(badcaseFeedback.id,feedback.id)));
  return {id:feedback.id,status,activationStatus:'NOT_PUBLISHED' as const};
 });
}

export function alertFeedbackReviewDigest(feedback:Pick<typeof badcaseFeedback.$inferSelect,'requestHash'|'decisionId'|'riskType'|'expectedAction'|'predictedAction'|'classification'|'disposition'>){
 return sha256(canonicalJson({requestHash:feedback.requestHash,decisionId:feedback.decisionId,riskType:feedback.riskType,expectedAction:feedback.expectedAction,predictedAction:feedback.predictedAction,classification:feedback.classification,reason:feedback.disposition}));
}
