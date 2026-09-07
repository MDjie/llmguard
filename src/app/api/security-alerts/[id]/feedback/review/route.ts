import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { feedbackReviewSchema, reviewAlertFeedback } from '@/lib/security-alerts/feedback';
export const POST=withApiSecurity({permission:'audit:approve',paramsSchema:z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),bodySchema:feedbackReviewSchema,maxBodyBytes:8192,responseSchema:z.object({id:z.uuid(),status:z.string(),activationStatus:z.literal('NOT_PUBLISHED')}).strict(),auditEvent:'security.alerts.feedback.review',rateLimitPolicy:{id:'alert-feedback-review',windowMs:60000,maxRequests:30,scope:'principal'}},async({principal,routeContext,body})=>{const{id}=await(routeContext as {params:Promise<{id:string}>}).params;return Response.json(await reviewAlertFeedback(requireTenantContext(principal),id,body));});
