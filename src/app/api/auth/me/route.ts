import { z } from 'zod';
import { ApiProblem, PLATFORM_PERMISSIONS, withApiSecurity } from '@/lib/api-security';
import { findUserById, normalizePlatformRole } from '@/lib/auth';

const meResponseSchema = z.object({
  success: z.literal(true),
  user: z.object({
    id: z.string(),
    username: z.string(),
    nickname: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    department: z.string().nullable(),
    role: z.string(),
    permissions: z.array(z.enum(PLATFORM_PERMISSIONS)),
    mustChangePassword: z.boolean(),
    tenantId: z.string(),
    applicationId: z.string(),
  }),
});

export const GET = withApiSecurity(
  {
    responseSchema: meResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'auth.me.read',
    rateLimitPolicy: {
      id: 'auth-me',
      windowMs: 60_000,
      maxRequests: 120,
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

    return Response.json({
      success: true as const,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        email: user.email,
        phone: user.phone,
        department: user.department,
        role,
        permissions: [...principal.permissions],
        mustChangePassword: Boolean(user.mustChangePassword),
        tenantId: principal.tenantId!,
        applicationId: principal.applicationId!,
      },
    });
  },
);
