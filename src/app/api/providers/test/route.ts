import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { callProviderChat } from '@/lib/providers';
import { providerConnectionTestOptions, providerTestFailure, type ProviderTestFailure } from '@/lib/providers/connection-test';
import { logger } from '@/lib/observability/logger';
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
    errorMessage: z.string().optional(),
    upstreamStatus: z.number().int().min(100).max(599).optional(),
    upstreamCode: z.string().regex(/^\d{4}$/u).optional(),
  }),
});

export const POST = withApiSecurity(
  {
    permission: 'provider:test',
    bodySchema,
    responseSchema,
    maxBodyBytes: 4_096,
    auditEvent: 'provider.test',
    rateLimitPolicy: { id: 'provider-test', windowMs: 60_000, maxRequests: 10, scope: 'principal' },
  },
  async ({ body, request, principal, requestContext }) => {
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
    let failure: ProviderTestFailure | undefined;
    const startedAt = Date.now();
    try {
      const result = await callProviderChat(provider, [{ role: 'user', content: 'Reply with OK only.' }], {
        ...providerConnectionTestOptions(provider),
        signal: request.signal,
      });
      testSuccess = true;
      latencyMs = result.latencyMs;
    } catch (error) {
      latencyMs = Date.now() - startedAt;
      failure = providerTestFailure(error);
      logger.warn('provider.connection.failed', {
        providerId: provider.id,
        providerType: provider.providerType,
        errorCode: failure.errorCode,
        upstreamStatus: failure.upstreamStatus,
        upstreamCode: failure.upstreamCode,
        traceId: requestContext.traceId,
        latencyMs,
      });
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
        ...failure,
      },
    });
  },
);
