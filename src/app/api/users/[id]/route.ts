import { z } from 'zod';
import { ApiProblem, withApiSecurity, type ApiContext } from '@/lib/api-security';
import { findUserByEmail, updateOwnProfile } from '@/lib/auth';

type ProfileRouteContext = { params: Promise<{ id: string }> };
type DefaultQuery = Readonly<Record<string, string | readonly string[]>>;

const profileBodySchema = z
  .object({
    nickname: z.string().trim().max(100).nullable().optional(),
    email: z.email().max(255).nullable().optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    department: z.string().trim().max(100).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });

const profileResponseSchema = z.object({
  success: z.literal(true),
  user: z.object({
    id: z.string(),
    nickname: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    department: z.string().nullable(),
  }),
});

export const PATCH = withApiSecurity(
  {
    permission: 'profile:self:write',
    bodySchema: profileBodySchema,
    responseSchema: profileResponseSchema,
    maxBodyBytes: 8_192,
    auditEvent: 'iam.profile.update',
    rateLimitPolicy: { id: 'iam-profile-update', windowMs: 60_000, maxRequests: 20, scope: 'principal' },
  },
  async ({ body, principal, routeContext }: ApiContext<
    z.infer<typeof profileBodySchema>,
    DefaultQuery,
    ProfileRouteContext
  >) => {
    if (!principal) throw new Error('Authenticated principal missing after authorization');
    const { id } = await routeContext.params;
    if (principal.subject !== id) {
      throw new ApiProblem({
        status: 403,
        code: 'PROFILE_SCOPE_DENIED',
        title: '无权修改',
        detail: '只能修改自己的个人资料。',
      });
    }
    if (body.email) {
      const emailOwner = await findUserByEmail(body.email);
      if (emailOwner && emailOwner.id !== id) {
        throw new ApiProblem({
          status: 409,
          code: 'EMAIL_CONFLICT',
          title: '邮箱已存在',
          detail: '该邮箱已被使用。',
        });
      }
    }

    const updated = await updateOwnProfile(id, body, new Date());
    if (!updated) {
      throw new ApiProblem({
        status: 404,
        code: 'USER_NOT_FOUND',
        title: '用户不存在',
        detail: '未找到指定用户。',
      });
    }
    return Response.json({
      success: true as const,
      user: {
        id: updated.id,
        nickname: updated.nickname,
        email: updated.email,
        phone: updated.phone,
        department: updated.department,
      },
    });
  },
);
