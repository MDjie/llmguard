import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { clearSessionCookies, revokeUserSessions } from '@/lib/auth';

const logoutResponseSchema = z.object({ success: z.literal(true) });

export const POST = withApiSecurity(
  {
    responseSchema: logoutResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'auth.logout',
    rateLimitPolicy: {
      id: 'auth-logout',
      windowMs: 60_000,
      maxRequests: 20,
      scope: 'principal',
    },
  },
  async ({ principal }) => {
    if (!principal) {
      throw new ApiProblem({
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        title: '未登录',
        detail: '登录会话无效或已过期。',
      });
    }

    await revokeUserSessions(principal.subject, new Date());
    const response = NextResponse.json({ success: true as const });
    clearSessionCookies(response);
    return response;
  },
);
