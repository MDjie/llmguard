import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { finishOidc } from '@/lib/iam/oidc';
const callbackSchema = z.object({state:z.string().max(64),code:z.string().max(4096).optional(),
  session_state:z.string().max(256).optional(),iss:z.string().max(512).optional(),
  error:z.string().max(128).optional(),error_description:z.string().max(1024).optional()}).strict();
export const GET = withApiSecurity({public:true,querySchema:callbackSchema,maxBodyBytes:0,
  auditEvent:'auth.oidc.callback',rateLimitPolicy:{id:'oidc-callback',windowMs:60000,maxRequests:15,scope:'ip'}},
  async ({request}) => {
    try { return await finishOidc(request); }
    catch { throw new ApiProblem({status:401,code:'OIDC_LOGIN_FAILED',title:'企业登录失败',
      detail:'请重新发起企业登录，并确认已完成多因素认证、账户绑定及应用授权。'}); }
  });
