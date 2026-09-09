import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { createIamUserSchema, updateIamUserSchema, iamUserListSchema } from '@/contracts/http/iam';
import { changeManagedUser, createUserWithGrants, listManagedUsers } from '@/lib/iam/management';

export const GET = withApiSecurity({
  permission: 'iam:users:read', querySchema: iamUserListSchema, responseSchema: jsonObjectResponseSchema,
  maxBodyBytes: 0, auditEvent: 'iam.users.list',
  rateLimitPolicy: { id: 'iam-users-list', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
}, async ({ principal, query }) => Response.json(await listManagedUsers(principal!, query)));

export const POST = withApiSecurity({
  permission: 'iam:users:manage', bodySchema: createIamUserSchema, responseSchema: jsonObjectResponseSchema,
  maxBodyBytes: 65_536, auditEvent: 'iam.users.create',
  rateLimitPolicy: { id: 'iam-users-create', windowMs: 60_000, maxRequests: 20, scope: 'principal' },
}, async ({ principal, body }) => Response.json(await createUserWithGrants(principal!, body), { status: 201 }));

export const PUT = withApiSecurity({
  permission: 'iam:users:manage', bodySchema: updateIamUserSchema, responseSchema: jsonObjectResponseSchema,
  maxBodyBytes: 65_536, auditEvent: 'iam.users.update',
  rateLimitPolicy: { id: 'iam-users-update', windowMs: 60_000, maxRequests: 30, scope: 'principal' },
}, async ({ principal, body }) => Response.json(await changeManagedUser(principal!, body)));

// Preserve identity references in audit records. Deletion deactivates the account.
export const DELETE = withApiSecurity({
  permission: 'iam:users:manage',
  querySchema: z.object({ id: z.string().min(1).max(36), expectedTokenVersion: z.coerce.number().int().nonnegative(),
    reason: z.string().trim().min(5).max(1000) }).strict(),
  responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0, auditEvent: 'iam.users.disable',
  rateLimitPolicy: { id: 'iam-users-disable', windowMs: 60_000, maxRequests: 10, scope: 'principal' },
}, async ({ principal, query }) => Response.json(await changeManagedUser(principal!, { ...query, status: 'disabled' })));
