import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  createManagedUser,
  deleteManagedUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  hashPassword,
  listUsers,
  normalizePlatformRole,
  updateManagedUser,
  validatePasswordPolicy,
} from '@/lib/auth';
import type { UserRecord } from '@/lib/auth/repository';

const platformRoleSchema = z.enum([
  'SYSTEM_ADMIN',
  'SECURITY_ADMIN',
  'AUDIT_ADMIN',
  'BUSINESS_OPERATOR',
  'APP_DEVELOPER',
  'READ_ONLY',
]);
const statusSchema = z.enum(['active', 'disabled', 'locked']);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const publicUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  nickname: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  avatar: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  department: z.string().nullable(),
  description: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  loginCount: z.number().int(),
  failedLoginCount: z.number().int(),
  lockedUntil: z.string().nullable(),
  passwordChangedAt: z.string().nullable(),
  mustChangePassword: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().nullable(),
});

const listQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    keyword: z.string().trim().max(100).optional(),
    role: platformRoleSchema.optional(),
    status: statusSchema.optional(),
  })
  .strict();

const createBodySchema = z
  .object({
    username: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9._-]+$/),
    password: z.string().min(1).max(128),
    nickname: optionalText(100),
    email: z.email().max(255).nullable().optional(),
    phone: optionalText(20),
    role: platformRoleSchema.default('BUSINESS_OPERATOR'),
    department: optionalText(100),
    description: optionalText(1_000),
  })
  .strict();

const updateBodySchema = z
  .object({
    id: z.string().min(1).max(36),
    nickname: optionalText(100),
    email: z.email().max(255).nullable().optional(),
    phone: optionalText(20),
    role: platformRoleSchema.optional(),
    status: statusSchema.optional(),
    department: optionalText(100),
    description: optionalText(1_000),
    password: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'id'), {
    message: 'At least one update field is required',
  });

const deleteQuerySchema = z.object({ id: z.string().min(1).max(36) }).strict();

type PublicUserRecord = Omit<UserRecord, 'password' | 'lastLoginIp' | 'tokenVersion'>;

function serializeUser(user: PublicUserRecord) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    email: user.email,
    phone: user.phone,
    avatar: user.avatar,
    role: normalizePlatformRole(user.role) ?? user.role,
    status: user.status,
    department: user.department,
    description: user.description,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    loginCount: user.loginCount ?? 0,
    failedLoginCount: user.failedLoginCount ?? 0,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    passwordChangedAt: user.passwordChangedAt?.toISOString() ?? null,
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    createdBy: user.createdBy,
  };
}

const userListResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(publicUserSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  }),
});
const userResponseSchema = z.object({ success: z.literal(true), data: publicUserSchema });
const successResponseSchema = z.object({ success: z.literal(true) });

export const GET = withApiSecurity(
  {
    permission: 'iam:users:read',
    querySchema: listQuerySchema,
    responseSchema: userListResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'iam.users.list',
    rateLimitPolicy: { id: 'iam-users-list', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
  },
  async ({ query }) => {
    const result = await listUsers(query);
    return Response.json({
      success: true as const,
      data: {
        items: result.items.map(serializeUser),
        total: result.total,
        page: query.page,
        pageSize: query.pageSize,
      },
    });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'iam:users:manage',
    bodySchema: createBodySchema,
    responseSchema: userResponseSchema,
    maxBodyBytes: 16_384,
    auditEvent: 'iam.users.create',
    rateLimitPolicy: { id: 'iam-users-create', windowMs: 60_000, maxRequests: 20, scope: 'principal' },
  },
  async ({ body, principal }) => {
    if (!principal) throw new Error('Authenticated principal missing after authorization');
    const passwordPolicy = validatePasswordPolicy(body.password, [body.username, body.email ?? '']);
    if (!passwordPolicy.valid) {
      throw new ApiProblem({
        status: 400,
        code: 'PASSWORD_POLICY_FAILED',
        title: '密码不符合要求',
        detail: `密码策略未通过：${passwordPolicy.violations.join(', ')}`,
      });
    }
    if (await findUserByUsername(body.username)) {
      throw new ApiProblem({
        status: 409,
        code: 'USERNAME_CONFLICT',
        title: '用户名已存在',
        detail: '该用户名已被使用。',
      });
    }
    if (body.email && (await findUserByEmail(body.email))) {
      throw new ApiProblem({
        status: 409,
        code: 'EMAIL_CONFLICT',
        title: '邮箱已存在',
        detail: '该邮箱已被使用。',
      });
    }

    const user = await createManagedUser({
      username: body.username,
      passwordHash: await hashPassword(body.password),
      nickname: body.nickname ?? body.username,
      email: body.email ?? null,
      phone: body.phone ?? null,
      role: body.role,
      department: body.department ?? null,
      description: body.description ?? null,
      createdBy: principal.subject,
      now: new Date(),
    });
    return Response.json({ success: true as const, data: serializeUser(user) }, { status: 201 });
  },
);

export const PUT = withApiSecurity(
  {
    permission: 'iam:users:manage',
    bodySchema: updateBodySchema,
    responseSchema: userResponseSchema,
    maxBodyBytes: 16_384,
    auditEvent: 'iam.users.update',
    rateLimitPolicy: { id: 'iam-users-update', windowMs: 60_000, maxRequests: 30, scope: 'principal' },
  },
  async ({ body, principal }) => {
    if (!principal) throw new Error('Authenticated principal missing after authorization');
    const existing = await findUserById(body.id);
    if (!existing) {
      throw new ApiProblem({
        status: 404,
        code: 'USER_NOT_FOUND',
        title: '用户不存在',
        detail: '未找到指定用户。',
      });
    }
    if (principal.subject === body.id && (body.role || (body.status && body.status !== 'active'))) {
      throw new ApiProblem({
        status: 403,
        code: 'SELF_PRIVILEGE_CHANGE_REJECTED',
        title: '操作被拒绝',
        detail: '不能修改自己的角色或禁用自己的账户。',
      });
    }
    if (body.email) {
      const emailOwner = await findUserByEmail(body.email);
      if (emailOwner && emailOwner.id !== body.id) {
        throw new ApiProblem({
          status: 409,
          code: 'EMAIL_CONFLICT',
          title: '邮箱已存在',
          detail: '该邮箱已被使用。',
        });
      }
    }

    let passwordHash: string | undefined;
    if (body.password) {
      const passwordPolicy = validatePasswordPolicy(body.password, [existing.username, body.email ?? existing.email ?? '']);
      if (!passwordPolicy.valid) {
        throw new ApiProblem({
          status: 400,
          code: 'PASSWORD_POLICY_FAILED',
          title: '密码不符合要求',
          detail: `密码策略未通过：${passwordPolicy.violations.join(', ')}`,
        });
      }
      passwordHash = await hashPassword(body.password);
    }

    const updated = await updateManagedUser(body.id, {
      ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.department !== undefined ? { department: body.department } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(passwordHash ? { passwordHash, mustChangePassword: true } : {}),
      revokeSessions: Boolean(passwordHash || body.role || body.status),
      now: new Date(),
    });
    if (!updated) throw new Error('User disappeared during update');
    return Response.json({ success: true as const, data: serializeUser(updated) });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'iam:users:manage',
    querySchema: deleteQuerySchema,
    responseSchema: successResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'iam.users.delete',
    rateLimitPolicy: { id: 'iam-users-delete', windowMs: 60_000, maxRequests: 10, scope: 'principal' },
  },
  async ({ query, principal }) => {
    if (!principal) throw new Error('Authenticated principal missing after authorization');
    if (principal.subject === query.id) {
      throw new ApiProblem({
        status: 403,
        code: 'SELF_DELETE_REJECTED',
        title: '操作被拒绝',
        detail: '不能删除自己的账户。',
      });
    }
    const existing = await findUserById(query.id);
    if (!existing) {
      throw new ApiProblem({
        status: 404,
        code: 'USER_NOT_FOUND',
        title: '用户不存在',
        detail: '未找到指定用户。',
      });
    }
    if (existing.username === 'admin') {
      throw new ApiProblem({
        status: 403,
        code: 'BOOTSTRAP_ADMIN_DELETE_REJECTED',
        title: '操作被拒绝',
        detail: '引导管理员账户不能通过普通接口删除。',
      });
    }
    if (!(await deleteManagedUser(query.id))) throw new Error('User delete returned no row');
    return Response.json({ success: true as const });
  },
);
