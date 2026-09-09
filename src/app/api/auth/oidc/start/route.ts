import { withApiSecurity } from '@/lib/api-security';
import { beginOidc } from '@/lib/iam/oidc';
import { emptyQuerySchema } from '@/contracts/http/common';
export const GET = withApiSecurity({ public:true, querySchema:emptyQuerySchema,maxBodyBytes:0,
  auditEvent:'auth.oidc.start',rateLimitPolicy:{id:'oidc-start',windowMs:60000,maxRequests:10,scope:'ip'} },
  async () => beginOidc());
