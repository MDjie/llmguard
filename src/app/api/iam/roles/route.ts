import { withApiSecurity, PLATFORM_ROLES } from '@/lib/api-security';
import { permissionsForRole } from '@/lib/auth/authorization';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
export const GET = withApiSecurity({
  permission:'profile:self:write',responseSchema:jsonObjectResponseSchema,maxBodyBytes:0,auditEvent:'iam.roles.read',
  rateLimitPolicy:{id:'iam-roles-read',windowMs:60_000,maxRequests:60,scope:'principal'},
},async()=>Response.json({items:PLATFORM_ROLES.map(role=>({role,permissions:permissionsForRole(role)}))}));
