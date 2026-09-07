import { z } from 'zod';
import { withApiSecurity,ApiProblem } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { createFeedbackCandidate,feedbackCandidateInputSchema,listFeedbackCandidateSources } from '@/lib/security-alerts/feedback-candidate';
import { workbenchRecordSchema } from '@/lib/evaluation/dataset-workbench';
export const POST=withApiSecurity({permission:'content:raw:read',paramsSchema:z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),bodySchema:feedbackCandidateInputSchema,maxBodyBytes:4096,
 responseSchema:z.object({candidateId:z.string(),workbench:z.object({schemaVersion:z.string(),kind:z.string(),records:z.array(workbenchRecordSchema),comparisons:z.number(),digest:z.string(),qualityStatus:z.string()}).strict()}).strict(),auditEvent:'security.alerts.feedback.candidate',rateLimitPolicy:{id:'feedback-candidate-export',windowMs:60000,maxRequests:10,scope:'principal'}},async({principal,routeContext,body})=>{const{id}=await(routeContext as {params:Promise<{id:string}>}).params;const result=await createFeedbackCandidate(requireTenantContext(principal),id,body).catch(candidateProblem);return Response.json(result,{headers:{'cache-control':'no-store, max-age=0',pragma:'no-cache','content-disposition':'attachment; filename="feedback-candidate.json"'}});});

function candidateProblem(error:unknown):never {
 const code=error instanceof Error?error.message:'';
 if(/^(CANDIDATE_|INDEPENDENT_FEEDBACK_TRIAGE_REQUIRED$|FEEDBACK_ALERT_UNAVAILABLE$)/.test(code))throw new ApiProblem({status:409,code,title:'Candidate export unavailable',detail:code});
 throw error;
}
export const GET=withApiSecurity({permission:'content:raw:read',paramsSchema:z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),querySchema:z.object({afterId:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),maxBodyBytes:0,
 responseSchema:z.object({items:z.array(z.object({id:z.string(),resourceType:z.enum(['MEDIA_EVIDENCE','ARCHIVED_CONTENT']),sourceDigest:z.string(),label:z.string()}).strict()).max(26),hasMore:z.boolean(),nextAfterId:z.string().nullable()}).strict(),auditEvent:'security.alerts.feedback.sources',rateLimitPolicy:{id:'feedback-candidate-sources',windowMs:60000,maxRequests:60,scope:'principal'}},async({principal,routeContext,query})=>{const{id}=await(routeContext as {params:Promise<{id:string}>}).params;return Response.json(await listFeedbackCandidateSources(requireTenantContext(principal),id,query.afterId).catch(candidateProblem),{headers:{'cache-control':'no-store'}});});
