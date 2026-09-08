import { withApiSecurity } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { inspectRuntime } from '@/lib/operations/inspection';
export const runtime='nodejs';
export const GET=withApiSecurity({permission:'observability:metrics:read',responseSchema:jsonObjectResponseSchema,maxBodyBytes:0,auditEvent:'operations.inspection',rateLimitPolicy:{id:'operations-inspection',windowMs:60000,maxRequests:30,scope:'principal'}},async()=>Response.json({success:true,data:await inspectRuntime()},{headers:{'cache-control':'no-store'}}));
