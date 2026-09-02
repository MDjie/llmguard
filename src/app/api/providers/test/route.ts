import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { EgressPolicyError, EgressRequestError } from '@/lib/egress';
import { callProviderChat, ProviderConfigurationError } from '@/lib/providers';
import { db } from '@/storage/database/shared/db';
import { llmProviders } from '@/storage/database/shared/schema';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

const bodySchema = z.object({ providerId: z.string().min(1).max(36) }).strict();
const responseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    providerId: z.string(),
    testSuccess: z.boolean(),
    latencyMs: z.number().int().nonnegative(),
    errorCode: z.string().optional(),
  }),
});

function safeErrorCode(error: unknown): string {
  if (
    error instanceof EgressPolicyError ||
    error instanceof EgressRequestError ||
    error instanceof ProviderConfigurationError
  ) {
    return error.code;
  }
  return 'PROVIDER_TEST_FAILED';
}

export const POST = withApiSecurity(
  {
    permission: 'provider:test',
    bodySchema,
    responseSchema,
    maxBodyBytes: 4_096,
    auditEvent: 'provider.test',
    rateLimitPolicy: { id: 'provider-test', windowMs: 60_000, maxRequests: 10, scope: 'principal' },
  },
  async ({ body, request, principal }) => {
    const scope = requireTenantContext(principal);
    const [provider] = await db
      .select()
      .from(llmProviders)
      .where(and(
        eq(llmProviders.id, body.providerId),
        scopePredicate(llmProviders, scope),
      ))
      .limit(1);
    if (!provider) {
      throw new ApiProblem({
        status: 404,
        code: 'PROVIDER_NOT_FOUND',
        title: 'Provider 不存在',
        detail: '未找到指定 Provider。',
      });
    }

    let testSuccess = false;
    let latencyMs = 0;
    let errorCode: string | undefined;
    const startedAt = Date.now();
    try {
      const result = await callProviderChat(provider, [{ role: 'user', content: 'ping' }], {
        maxTokens: 10,
        temperature: 0,
        timeoutMs: 10_000,
        signal: request.signal,
      });
      testSuccess = true;
      latencyMs = result.latencyMs;
    } catch (error) {
      latencyMs = Date.now() - startedAt;
      errorCode = safeErrorCode(error);
    }

    await db
      .update(llmProviders)
      .set({
        lastTestAt: new Date(),
        lastTestSuccess: testSuccess,
        avgLatencyMs: latencyMs,
        updatedAt: new Date(),
      })
      .where(and(
        eq(llmProviders.id, provider.id),
        scopePredicate(llmProviders, scope),
      ));

    return Response.json({
      success: true as const,
      data: {
        providerId: provider.id,
        testSuccess,
        latencyMs,
        ...(errorCode ? { errorCode } : {}),
      },
    });
  },
);
