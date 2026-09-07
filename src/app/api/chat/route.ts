import { gatewayChatResponseSchema } from '@/contracts/http/gateway-chat';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { callGatewayConsole } from '@/lib/gateway-runtime/console-client';
import { GatewayError } from '@/lib/gateway-runtime/protocol';
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
    sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
    messages: z.array(messageSchema).min(1).max(100).optional(),
    text: z.string().min(1).max(32_768).optional(),
  })
  .strict()
  .refine((body) => Boolean(body.messages?.length || body.text), {
    message: 'messages or text is required',
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
    responseSchema: gatewayChatResponseSchema,
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
    if (!principal) throw new ApiProblem({ status: 401, code: 'AUTHENTICATION_REQUIRED', title: '请先登录', detail: '登录后重试。' });
    const result = await callGatewayConsole(principal, provider.id, messages, request.signal, body.sessionId, request.headers.get('idempotency-key') ?? undefined).catch((error: unknown) => {
      throw new ApiProblem({ status: error instanceof GatewayError ? error.status : 503, code: error instanceof GatewayError ? error.code : 'GATEWAY_UNAVAILABLE', title: '安全网关未批准本次请求', detail: '请在执行记录中查看请求状态或检查网关接入配置。' });
    });
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
        gateway: result.gateway,
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
