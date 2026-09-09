import { z } from 'zod';
import { grantAttributesSchema } from '@/lib/iam/policy';

const id = z.string().min(1).max(128);
const code = z.string().min(2).max(64).regex(/^[a-z][a-z0-9_-]*$/);
const status = z.enum(['active', 'disabled']);

export const createTenantSchema = z.object({
  code,
  name: z.string().trim().min(2).max(200),
  defaultApplicationCode: code.default('default'),
  defaultApplicationName: z.string().trim().min(2).max(200).default('Default application'),
}).strict();

export const applicationMetadataSchema = z.object({
  owner:z.string().trim().max(200).nullable().optional(),department:z.string().trim().max(200).nullable().optional(),
  environment:z.enum(['development','test','staging','production']).optional(),dataClass:z.enum(['public','internal','confidential','restricted']).optional(),
  modelRoutes:z.array(z.string().trim().min(1).max(128)).max(64).refine(items=>new Set(items).size===items.length,'模型路由不可重复').optional(),
});
export const createApplicationSchema = applicationMetadataSchema.extend({code,name:z.string().trim().min(2).max(200)}).strict();
export const updateApplicationSchema = applicationMetadataSchema.extend({id,expectedAuthVersion:z.number().int().positive(),name:z.string().trim().min(2).max(200)}).strict();

export const selectApplicationScopeSchema = z.object({
  tenantId: id,
  applicationId: id,
}).strict();

export const selectedApplicationScopeResponseSchema = z.object({
  success: z.literal(true),
  tenantId: id,
  applicationId: id,
});

export const applicationCredentialPermissionsSchema = z.array(
  z.enum(['guard:use', 'application:integrate']),
).min(1).max(2);

export const createApplicationCredentialSchema = z.object({
  name: z.string().trim().min(2).max(128),
  permissions: applicationCredentialPermissionsSchema.default(['guard:use']),
  expiresAt: z.iso.datetime().optional(),
}).strict();

export const revokeApplicationCredentialQuerySchema = z.object({
  id,
}).strict();

export const tenantResponseSchema = z.object({
  id,
  code,
  name: z.string(),
  status,
  createdAt: z.string(),
});

export const applicationResponseSchema = applicationMetadataSchema.extend({
  authorizationAttributes:grantAttributesSchema.optional(),
  authVersion:z.number().int().positive().optional(),integrationState:z.string().optional(),
  id,
  tenantId: id,
  code,
  name: z.string(),
  status,
  createdAt: z.string(),
});

export const credentialResponseSchema = z.object({
  id,
  keyId: z.string(),
  name: z.string(),
  permissions: applicationCredentialPermissionsSchema,
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const tenantListResponseSchema = z.object({
  items: z.array(tenantResponseSchema),
});

export const applicationListResponseSchema = z.object({
  currentApplicationId:z.string().optional(),
  items: z.array(applicationResponseSchema),
});

export const credentialListResponseSchema = z.object({
  items: z.array(credentialResponseSchema),
});

export const createdTenantResponseSchema = z.object({
  tenant: tenantResponseSchema,
  application: applicationResponseSchema,
});

export const createdApplicationCredentialResponseSchema = z.object({
  credential: credentialResponseSchema,
  apiKey: z.string().min(40),
});
