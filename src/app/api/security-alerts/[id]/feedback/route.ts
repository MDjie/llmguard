import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { alertFeedbackSchema, submitAlertFeedback, listAlertFeedback } from '@/lib/security-alerts/feedback';
export const POST=withApiSecurity({permission:'security:operate',paramsSchema:z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),bodySchema:alertFeedbackSchema,maxBodyBytes:8192,
 responseSchema:z.object({id:z.uuid(),created:z.boolean(),status:z.string().min(1).max(32),activationStatus:z.literal('NOT_PUBLISHED')}).strict(),auditEvent:'security.alerts.feedback',
 rateLimitPolicy:{id:'security-alert-feedback',windowMs:60000,maxRequests:30,scope:'principal'}},async({principal,routeContext,body})=>{
 const {id}=await(routeContext as {params:Promise<{id:string}>}).params;
 return Response.json(await submitAlertFeedback(requireTenantContext(principal),id,body));
});

export const GET=withApiSecurity({permission:'security:operate',paramsSchema:z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),maxBodyBytes:0,
 responseSchema:z.object({items:z.array(z.object({id:z.uuid(),submittedBy:z.string().nullable(),classification:z.string(),expectedAction:z.string(),predictedAction:z.string(),status:z.string(),reason:z.string().nullable(),createdAt:z.iso.datetime(),reviewedBy:z.string().nullable(),reviewDecision:z.string().nullable(),reviewReason:z.string().nullable()}).strict()).max(100)}).strict(),auditEvent:'security.alerts.feedback.list',rateLimitPolicy:{id:'alert-feedback-list',windowMs:60000,maxRequests:120,scope:'principal'}},async({principal,routeContext})=>{const{id}=await(routeContext as {params:Promise<{id:string}>}).params;return Response.json({items:await listAlertFeedback(requireTenantContext(principal),id)});});
