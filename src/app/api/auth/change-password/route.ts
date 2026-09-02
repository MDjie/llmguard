import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  changePasswordAndRevokeSessions,
  findUserById,
  hashPassword,
  issueSession,
  listRecentPasswordHashes,
  normalizePlatformRole,
  passwordMatchesHistory,
  setSessionCookies,
  validatePasswordPolicy,
  verifyStoredPassword,
} from '@/lib/auth';

const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(1).max(128),
  })
  .strict();

const changePasswordResponseSchema = z.object({
  success: z.literal(true),
  mustChangePassword: z.literal(false),
});

export const POST = withApiSecurity(
  {
    permission: 'auth:password:change',
    bodySchema: changePasswordBodySchema,
    responseSchema: changePasswordResponseSchema,
    maxBodyBytes: 4_096,
    auditEvent: 'auth.password.change',
    rateLimitPolicy: {
      id: 'auth-change-password',
      windowMs: 15 * 60_000,
      maxRequests: 5,
      scope: 'principal',
    },
  },
  async ({ body, principal }) => {
    if (!principal) {
      throw new ApiProblem({
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
        title: '未登录',
        detail: '登录会话无效或已过期。',
      });
    }

    const user = await findUserById(principal.subject);
    const role = user ? normalizePlatformRole(user.role) : null;
    if (!user || !role) {
      throw new ApiProblem({
        status: 401,
        code: 'SESSION_USER_NOT_FOUND',
        title: '登录已失效',
        detail: '登录会话对应的用户已不存在或不可用。',
      });
    }

    const currentVerification = await verifyStoredPassword(body.currentPassword, user.password);
    if (!currentVerification.valid) {
      throw new ApiProblem({
        status: 400,
        code: 'CURRENT_PASSWORD_INVALID',
        title: '当前密码错误',
        detail: '当前密码校验失败。',
      });
    }
    const recentHashes = await listRecentPasswordHashes(user.id);
    if (await passwordMatchesHistory(body.newPassword, [user.password, ...recentHashes])) {
      throw new ApiProblem({
        status: 400,
        code: 'PASSWORD_REUSE_REJECTED',
        title: '新密码无效',
        detail: '新密码不能与当前密码或最近使用的密码相同。',
      });
    }

    const policy = validatePasswordPolicy(body.newPassword, [user.username, user.email ?? '']);
    if (!policy.valid) {
      throw new ApiProblem({
        status: 400,
        code: 'PASSWORD_POLICY_FAILED',
        title: '新密码不符合要求',
        detail: `密码策略未通过：${policy.violations.join(', ')}`,
      });
    }

    const passwordHash = await hashPassword(body.newPassword);
    const updated = await changePasswordAndRevokeSessions(user.id, passwordHash, new Date());
    const session = issueSession(
      {
        id: updated.id,
        username: updated.username,
        role,
        tokenVersion: updated.tokenVersion,
      },
      false,
    );
    const response = NextResponse.json({
      success: true as const,
      mustChangePassword: false as const,
    });
    setSessionCookies(response, session);
    return response;
  },
);
