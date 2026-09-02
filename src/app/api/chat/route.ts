import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { callProviderChat } from '@/lib/providers';
import { db } from '@/storage/database/shared/db';
import { llmProviders } from '@/storage/database/shared/schema';
import { requireTenantContext, scopePredicate, type TenantScope } from '@/lib/tenancy';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(32_768),
});
const chatBodySchema = z
  .object({
    providerId: z.string().min(1).max(36).optional(),
    messages: z.array(messageSchema).min(1).max(100).optional(),
    text: z.string().min(1).max(32_768).optional(),
  })
  .strict()
  .refine((body) => Boolean(body.messages?.length || body.text), {
    message: 'messages or text is required',
  });
const providerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  model: z.string().nullable(),
});
const chatResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    provider: providerSummarySchema,
    response: z.string(),
    latencyMs: z.number().int().nonnegative(),
  }),
});
const listResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      displayName: z.string(),
      providerType: z.string(),
      defaultModel: z.string().nullable(),
      useCase: z.string().nullable(),
      isEnabled: z.boolean(),
      isDefaultTarget: z.boolean(),
      avgLatencyMs: z.number().int().nullable(),
      lastTestSuccess: z.boolean().nullable(),
    }),
  ),
});

async function selectProvider(scope: TenantScope, providerId?: string) {
  if (providerId) {
    const [provider] = await db
      .select()
      .from(llmProviders)
      .where(and(
        eq(llmProviders.id, providerId),
        eq(llmProviders.isEnabled, true),
        scopePredicate(llmProviders, scope),
      ))
      .limit(1);
    return provider;
  }
  const [preferred] = await db
    .select()
    .from(llmProviders)
    .where(and(
      eq(llmProviders.isDefaultTarget, true),
      eq(llmProviders.isEnabled, true),
      scopePredicate(llmProviders, scope),
    ))
    .limit(1);
  if (preferred) return preferred;
  const [fallback] = await db
    .select()
    .from(llmProviders)
    .where(and(
      eq(llmProviders.isEnabled, true),
      scopePredicate(llmProviders, scope),
    ))
    .limit(1);
  return fallback;
}

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: chatBodySchema,
    responseSchema: chatResponseSchema,
    maxBodyBytes: 256 * 1_024,
    auditEvent: 'provider.chat',
    rateLimitPolicy: { id: 'provider-chat', windowMs: 60_000, maxRequests: 30, scope: 'principal' },
  },
  async ({ body, request, principal }) => {
    const provider = await selectProvider(requireTenantContext(principal), body.providerId);
    if (!provider) {
      throw new ApiProblem({
        status: 503,
        code: 'PROVIDER_UNAVAILABLE',
        title: '模型服务不可用',
        detail: '没有可用的目标模型 Provider。',
      });
    }
    const messages = body.messages ?? [{ role: 'user' as const, content: body.text ?? '' }];
    const result = await callProviderChat(provider, messages, { signal: request.signal });
    return Response.json({
      success: true as const,
      data: {
        provider: {
          id: provider.id,
          name: provider.name,
          displayName: provider.displayName,
          model: provider.defaultModel,
        },
        response: result.content,
        latencyMs: result.latencyMs,
      },
    });
  },
);

export const GET = withApiSecurity(
  {
    permission: 'provider:read',
    responseSchema: listResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'provider.target.list',
    rateLimitPolicy: { id: 'provider-target-list', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const providers = await db
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        displayName: llmProviders.displayName,
        providerType: llmProviders.providerType,
        defaultModel: llmProviders.defaultModel,
        useCase: llmProviders.useCase,
        isEnabled: llmProviders.isEnabled,
        isDefaultTarget: llmProviders.isDefaultTarget,
        avgLatencyMs: llmProviders.avgLatencyMs,
        lastTestSuccess: llmProviders.lastTestSuccess,
      })
      .from(llmProviders)
      .where(and(
        eq(llmProviders.isEnabled, true),
        scopePredicate(llmProviders, scope),
      ));
    return Response.json({
      success: true as const,
      data: providers.filter((provider) => provider.useCase === 'target' || provider.useCase === 'both'),
    });
  },
);
