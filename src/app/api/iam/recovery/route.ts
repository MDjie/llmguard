import { withApiSecurity } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { recoveryRequestSchema } from '@/contracts/http/iam';
import { requestEmergencyAccess } from '@/lib/iam/management';

export const POST = withApiSecurity({
  permission:'iam:recovery:approve',bodySchema:recoveryRequestSchema,responseSchema:jsonObjectResponseSchema,
  maxBodyBytes:4096,auditEvent:'iam.recovery.request',
  rateLimitPolicy:{id:'iam-recovery-request',windowMs:60_000,maxRequests:5,scope:'principal'},
},async({principal,body})=>Response.json(await requestEmergencyAccess(principal!,body.targetUserId,body.reason,body.durationMinutes),{status:201}));
