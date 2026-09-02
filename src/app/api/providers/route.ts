import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { EgressPolicyError, ProviderEndpointPolicy } from '@/lib/egress';
import { parseProviderType, providerBaseUrl } from '@/lib/providers';
import { getSecretProvider } from '@/lib/secrets';
import { db } from '@/storage/database/shared/db';
import { llmProviders } from '@/storage/database/shared/schema';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

type ProviderRecord = typeof llmProviders.$inferSelect;

const providerTypeSchema = z.enum([
  'openai_compatible',
  'deepseek',
  'kimi',
  'doubao',
  'qwen',
  'glm',
  'ollama',
  'custom',
]);
const useCaseSchema = z.enum(['target', 'judge', 'both', 'ocr']);
const providerOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  providerType: providerTypeSchema,
  baseUrl: z.string().nullable(),
  defaultModel: z.string().nullable(),
  useCase: z.string().nullable(),
  isEnabled: z.boolean(),
  isDefaultTarget: z.boolean(),
  isDefaultJudge: z.boolean(),
  avgLatencyMs: z.number().int().nullable(),
  lastTestAt: z.string().nullable(),
  lastTestSuccess: z.boolean().nullable(),
  hasSecret: z.boolean(),
  requiresSecretMigration: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

const createBodySchema = z
  .object({
    name: z.string().trim().min(2).max(100).regex(/^[A-Za-z0-9._-]+$/),
    displayName: z.string().trim().min(1).max(200),
    providerType: providerTypeSchema,
    baseUrl: z.url().max(500).nullable().optional(),
    apiKey: z.string().min(1).max(16_384).nullable().optional(),
    defaultModel: z.string().trim().min(1).max(100).nullable().optional(),
    useCase: useCaseSchema.default('both'),
  })
  .strict();

const updateBodySchema = z
  .object({
    name: z.string().trim().min(2).max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    providerType: providerTypeSchema.optional(),
    baseUrl: z.url().max(500).nullable().optional(),
    apiKey: z.string().min(1).max(16_384).nullable().optional(),
    defaultModel: z.string().trim().min(1).max(100).nullable().optional(),
    useCase: useCaseSchema.optional(),
    isEnabled: z.boolean().optional(),
    isDefaultTarget: z.boolean().optional(),
    isDefaultJudge: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });

const idQuerySchema = z.object({ id: z.string().min(1).max(36) }).strict();

function serializeProvider(provider: ProviderRecord) {
  const providerType = parseProviderType(provider.providerType);
  return {
    id: provider.id,
    name: provider.name,
    displayName: provider.displayName,
    providerType,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    useCase: provider.useCase,
    isEnabled: provider.isEnabled,
    isDefaultTarget: provider.isDefaultTarget,
    isDefaultJudge: provider.isDefaultJudge,
    avgLatencyMs: provider.avgLatencyMs,
    lastTestAt: provider.lastTestAt?.toISOString() ?? null,
    lastTestSuccess: provider.lastTestSuccess,
    hasSecret: Boolean(provider.secretRef),
    requiresSecretMigration: Boolean(provider.apiKeyEncrypted && !provider.secretRef),
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt?.toISOString() ?? null,
  };
}

const listResponseSchema = z.object({ success: z.literal(true), data: z.array(providerOutputSchema) });
const providerResponseSchema = z.object({ success: z.literal(true), data: providerOutputSchema });
const successResponseSchema = z.object({ success: z.literal(true) });

async function validatedBaseUrl(providerTypeValue: string, configured: string | null): Promise<string> {
  const providerType = parseProviderType(providerTypeValue);
  const value = providerBaseUrl(providerType, configured);
  try {
    await new ProviderEndpointPolicy().assertAllowed(value, providerType);
  } catch (error) {
    if (error instanceof EgressPolicyError) {
      throw new ApiProblem({
        status: 400,
        code: 'PROVIDER_ENDPOINT_REJECTED',
        title: 'Provider 地址不可用',
        detail: `Provider 地址未通过出网安全策略（${error.code}）。`,
      });
    }
    throw error;
  }
  return value.replace(/\/$/, '');
}

export const GET = withApiSecurity(
  {
    permission: 'provider:read',
    responseSchema: listResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'provider.list',
    rateLimitPolicy: { id: 'provider-list', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const providers = await db.select().from(llmProviders)
      .where(scopePredicate(llmProviders, scope))
      .orderBy(desc(llmProviders.createdAt));
    return Response.json({ success: true as const, data: providers.map(serializeProvider) });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'provider:manage',
    bodySchema: createBodySchema,
    responseSchema: providerResponseSchema,
    maxBodyBytes: 32_768,
    auditEvent: 'provider.create',
    rateLimitPolicy: { id: 'provider-create', windowMs: 60_000, maxRequests: 10, scope: 'principal' },
  },
  async ({ body, principal }) => {
    if (!principal) throw new Error('Authenticated principal missing after authorization');
    const scope = requireTenantContext(principal);
    if (body.providerType !== 'ollama' && !body.apiKey) {
      throw new ApiProblem({
        status: 400,
        code: 'PROVIDER_SECRET_REQUIRED',
        title: '缺少访问密钥',
        detail: '该 Provider 类型必须配置访问密钥。',
      });
    }
    const [existing] = await db
      .select({ id: llmProviders.id })
      .from(llmProviders)
      .where(and(
        eq(llmProviders.name, body.name),
        scopePredicate(llmProviders, scope),
      ))
      .limit(1);
    if (existing) {
      throw new ApiProblem({
        status: 409,
        code: 'PROVIDER_NAME_CONFLICT',
        title: 'Provider 名称已存在',
        detail: '请使用不同的 Provider 名称。',
      });
    }

    const effectiveBaseUrl = await validatedBaseUrl(body.providerType, body.baseUrl ?? null);
    const secretProvider = body.apiKey ? getSecretProvider(scope) : null;
    const secretRef = body.apiKey && secretProvider ? await secretProvider.put(body.apiKey) : null;
    try {
      const [provider] = await db
        .insert(llmProviders)
        .values({
          tenantId: scope.tenantId,
          applicationId: scope.applicationId,
          name: body.name,
          displayName: body.displayName,
          providerType: body.providerType,
          baseUrl: effectiveBaseUrl,
          secretRef,
          apiKeyEncrypted: null,
          defaultModel: body.defaultModel ?? null,
          useCase: body.useCase,
          isEnabled: true,
          createdBy: principal.subject,
          updatedAt: new Date(),
        })
        .returning();
      if (!provider) throw new Error('Provider insert returned no row');
      return Response.json({ success: true as const, data: serializeProvider(provider) }, { status: 201 });
    } catch (error) {
      if (secretRef && secretProvider) await secretProvider.delete(secretRef).catch(() => undefined);
      throw error;
    }
  },
);

export const PUT = withApiSecurity(
  {
    permission: 'provider:manage',
    querySchema: idQuerySchema,
    bodySchema: updateBodySchema,
    responseSchema: providerResponseSchema,
    maxBodyBytes: 32_768,
    auditEvent: 'provider.update',
    rateLimitPolicy: { id: 'provider-update', windowMs: 60_000, maxRequests: 20, scope: 'principal' },
  },
  async ({ body, query, principal }) => {
    const scope = requireTenantContext(principal);
    const [existing] = await db.select().from(llmProviders).where(and(
      eq(llmProviders.id, query.id),
      scopePredicate(llmProviders, scope),
    )).limit(1);
    if (!existing) {
      throw new ApiProblem({
        status: 404,
        code: 'PROVIDER_NOT_FOUND',
        title: 'Provider 不存在',
        detail: '未找到指定 Provider。',
      });
    }

    const providerType = body.providerType ?? parseProviderType(existing.providerType);
    const endpointChanged = body.providerType !== undefined || body.baseUrl !== undefined;
    const mustValidateEndpoint = endpointChanged || (body.isEnabled === true && !existing.isEnabled);
    const baseUrl = mustValidateEndpoint
      ? await validatedBaseUrl(providerType, body.baseUrl ?? existing.baseUrl)
      : existing.baseUrl;
    const retainsSecret =
      typeof body.apiKey === 'string' || (body.apiKey === undefined && Boolean(existing.secretRef));
    if (providerType !== 'ollama' && !retainsSecret) {
      throw new ApiProblem({
        status: 400,
        code: 'PROVIDER_SECRET_REQUIRED',
        title: '不能移除访问密钥',
        detail: '该 Provider 类型必须保留访问密钥。',
      });
    }

    const secretProvider = body.apiKey !== undefined ? getSecretProvider(scope) : null;
    const newSecretRef =
      typeof body.apiKey === 'string' && secretProvider
        ? await secretProvider.put(body.apiKey)
        : undefined;
    const removeSecret = body.apiKey === null;
    let updated: ProviderRecord;
    try {
      const [updatedRecord] = await db
        .update(llmProviders)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          providerType,
          baseUrl,
          ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
          ...(body.useCase !== undefined ? { useCase: body.useCase } : {}),
          ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
          ...(body.isDefaultTarget !== undefined ? { isDefaultTarget: body.isDefaultTarget } : {}),
          ...(body.isDefaultJudge !== undefined ? { isDefaultJudge: body.isDefaultJudge } : {}),
          ...(newSecretRef !== undefined ? { secretRef: newSecretRef, apiKeyEncrypted: null } : {}),
          ...(removeSecret ? { secretRef: null, apiKeyEncrypted: null } : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(llmProviders.id, query.id),
          scopePredicate(llmProviders, scope),
        ))
        .returning();
      if (!updatedRecord) throw new Error('Provider disappeared during update');
      updated = updatedRecord;
    } catch (error) {
      if (newSecretRef && secretProvider) await secretProvider.delete(newSecretRef).catch(() => undefined);
      throw error;
    }
    if ((newSecretRef !== undefined || removeSecret) && existing.secretRef && secretProvider) {
      await secretProvider.delete(existing.secretRef).catch(() => {
        console.error('Failed to remove superseded Provider secret');
      });
    }
    return Response.json({ success: true as const, data: serializeProvider(updated) });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'provider:manage',
    querySchema: idQuerySchema,
    responseSchema: successResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'provider.delete',
    rateLimitPolicy: { id: 'provider-delete', windowMs: 60_000, maxRequests: 10, scope: 'principal' },
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const [deleted] = await db
      .delete(llmProviders)
      .where(and(
        eq(llmProviders.id, query.id),
        scopePredicate(llmProviders, scope),
      ))
      .returning({ secretRef: llmProviders.secretRef });
    if (!deleted) {
      throw new ApiProblem({
        status: 404,
        code: 'PROVIDER_NOT_FOUND',
        title: 'Provider 不存在',
        detail: '未找到指定 Provider。',
      });
    }
    if (deleted.secretRef) await getSecretProvider(scope).delete(deleted.secretRef);
    return Response.json({ success: true as const });
  },
);
