import { withApiSecurity } from '@/lib/api-security';
import { oidcSettings } from '@/lib/iam/oidc-config';
import { emptyQuerySchema } from '@/contracts/http/common';
export const GET = withApiSecurity({public:true,querySchema:emptyQuerySchema,maxBodyBytes:0,
  auditEvent:'auth.oidc.config',rateLimitPolicy:{id:'oidc-config',windowMs:60000,maxRequests:60,scope:'ip'}},
  async () => {
    let enabled = false;
    try { oidcSettings(); enabled = true; } catch { /* Fail closed until configuration is complete. */ }
    return Response.json({enabled,requiredForAdministrators:process.env.IAM_ENTERPRISE_LOGIN_REQUIRED==='true'},
      {headers:{'cache-control':'no-store'}});
  });
