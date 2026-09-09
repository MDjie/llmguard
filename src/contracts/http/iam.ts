import { z } from 'zod';
import { PLATFORM_ROLES } from '@/lib/api-security/types';
import { grantAttributesSchema } from '@/lib/iam/policy';

const id = z.string().min(1).max(36);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
export const applicationGrantSchema = z.object({
  applicationId: id,
  attributes: grantAttributesSchema,
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict();
export const assignmentSchema = z.object({
  defaultApplicationId: id,
  grants: z.array(applicationGrantSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = value.grants.map(grant => grant.applicationId);
  if (new Set(ids).size !== ids.length || !ids.includes(value.defaultApplicationId)) {
    ctx.addIssue({ code: 'custom', message: '应用授权不可重复，默认应用必须属于授权集合。' });
  }
});
export const identitySchema = z.discriminatedUnion('loginMethod', [
  z.object({ loginMethod: z.literal('local') }).strict(),
  z.object({ loginMethod: z.literal('emergency') }).strict(),
  z.object({ loginMethod: z.literal('oidc'), issuer: z.url().max(512), subject: z.string().min(1).max(255) }).strict(),
]);
export const createIamUserSchema = z.object({
  username: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(1).max(128).optional(),
  nickname: optionalText(100), email: z.email().max(255).nullable().optional(),
  phone: optionalText(20), department: optionalText(100), description: optionalText(1000),
  role: z.enum(PLATFORM_ROLES).default('BUSINESS_OPERATOR'),
  assignment: assignmentSchema,
  identity: identitySchema.default({ loginMethod: 'local' }),
  reason: z.string().trim().min(5).max(1000),
}).strict().superRefine((value, ctx) => {
  if (value.identity.loginMethod !== 'oidc' && !value.password) ctx.addIssue({ code: 'custom', message: '本地及应急账户必须提供初始密码。' });
});
export const updateIamUserSchema = z.object({
  id, expectedTokenVersion: z.number().int().nonnegative(),
  nickname: optionalText(100), email: z.email().max(255).nullable().optional(),
  phone: optionalText(20), department: optionalText(100), description: optionalText(1000),
  role: z.enum(PLATFORM_ROLES).optional(), status: z.enum(['active','disabled','locked']).optional(),
  password: z.string().min(1).max(128).optional(),
  assignment: assignmentSchema.optional(), identity: identitySchema.optional(),
  reason: z.string().trim().min(5).max(1000),
}).strict().refine(value => Object.keys(value).some(key => !['id','reason','expectedTokenVersion'].includes(key)), '没有需要修改的字段。');
export const iamUserListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().max(100).optional(),
  role: z.enum(PLATFORM_ROLES).optional(),
  status: z.enum(['active','disabled','locked']).optional(),
}).strict();
export const iamDecisionSchema = z.object({
  id, decision: z.enum(['approve','reject']),
}).strict();
export const recoveryRequestSchema = z.object({
  targetUserId: id, reason: z.string().trim().min(10).max(1000),
  durationMinutes: z.number().int().min(5).max(60).default(15),
}).strict();
