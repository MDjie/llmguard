import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  authenticateCredentials,
  issueSession,
  normalizePlatformRole,
  setSessionCookies,
  clearScopeCookie,
} from '@/lib/auth';

const loginBodySchema = z
  .object({
    username: z.string().trim().min(1).max(50),
    password: z.string().min(1).max(128),
    rememberMe: z.boolean().default(false),
  })
  .strict();

const loginResponseSchema = z.object({
  success: z.literal(true),
  user: z.object({
    id: z.string(),
    username: z.string(),
    nickname: z.string().nullable(),
    email: z.string().nullable(),
    avatar: z.string().nullable(),
    role: z.string(),
    mustChangePassword: z.boolean(),
  }),
});

export const POST = withApiSecurity(
  {
    public: true,
    bodySchema: loginBodySchema,
    responseSchema: loginResponseSchema,
    maxBodyBytes: 4_096,
    auditEvent: 'auth.login',
    rateLimitPolicy: {
      id: 'auth-login',
      windowMs: 15 * 60_000,
      maxRequests: 5,
      scope: 'ip',
    },
  },
  async ({ body, requestContext }) => {
    const result = await authenticateCredentials({
      username: body.username,
      password: body.password,
      clientIp: requestContext.clientIp,
    });

    if (!result.success) {
      if (result.reason === 'ENTERPRISE_OR_RECOVERY_LOGIN_REQUIRED') {
        throw new ApiProblem({status:403,code:result.reason,title:'登录方式不符',detail:'请使用企业登录，或由独立审批人员启用应急访问。'});
      }
      if (result.reason === 'ACCOUNT_SCOPE_UNAVAILABLE') {
        throw new ApiProblem({status:403,code:result.reason,title:'账户尚未授权',detail:'请联系管理员配置有效的默认应用及应用授权。'});
      }
      throw new ApiProblem({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        title: '登录失败',
        detail: '用户名、密码或账户状态无效。',
      });
    }

    const role = normalizePlatformRole(result.user.role);
    if (!role) {
      throw new ApiProblem({
        status: 403,
        code: 'ACCOUNT_ROLE_INVALID',
        title: '账户不可用',
        detail: '账户角色配置无效，请联系管理员。',
      });
    }

    const session = issueSession(
      {
        id: result.user.id,
        username: result.user.username,
        role,
        tokenVersion: result.user.tokenVersion,
        ...(result.emergencyUntil ? { maxAgeSeconds: Math.floor((result.emergencyUntil.getTime()-Date.now())/1000) } : {}),
      },
      body.rememberMe,
    );
    const response = NextResponse.json({
      success: true as const,
      user: {
        id: result.user.id,
        username: result.user.username,
        nickname: result.user.nickname,
        email: result.user.email,
        avatar: result.user.avatar,
        role,
        mustChangePassword: Boolean(result.user.mustChangePassword),
      },
    });
    setSessionCookies(response, session);
    clearScopeCookie(response);
    return response;
  },
);
