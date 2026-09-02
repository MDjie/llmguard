import { NextResponse } from 'next/server';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { llmProviders, detectionDimensions } from '@/storage/database/shared/schema';
import { and, eq } from 'drizzle-orm';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

// GET: 获取裁判模型配置所需的辅助数据
async function getJudgeHelpers(
  _request: Request,
  _routeContext: unknown,
  apiContext: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(apiContext.principal);
    // 获取所有 Provider（配置页面需要展示所有可选的，包括关闭的）
    const judgeProviders = await db
      .select({
        id: llmProviders.id,
        name: llmProviders.name,
        displayName: llmProviders.displayName,
        providerType: llmProviders.providerType,
        defaultModel: llmProviders.defaultModel,
        useCase: llmProviders.useCase,
        isDefaultJudge: llmProviders.isDefaultJudge,
        isEnabled: llmProviders.isEnabled,
      })
      .from(llmProviders)
      .where(scopePredicate(llmProviders, scope));

    // 过滤出可以用作裁判模型的 Provider (useCase 为 'judge' 或 'both')
    const availableProviders = judgeProviders.filter(
      p => p.useCase === 'judge' || p.useCase === 'both'
    );

    // 获取所有启用的检测维度
    const dimensions = await db
      .select({
        id: detectionDimensions.id,
        code: detectionDimensions.code,
        name: detectionDimensions.name,
        category: detectionDimensions.category,
        description: detectionDimensions.description,
      })
      .from(detectionDimensions)
      .where(and(
        eq(detectionDimensions.enabled, true),
        scopePredicate(detectionDimensions, scope),
      ));

    return NextResponse.json({
      success: true,
      data: {
        providers: availableProviders.map(p => ({
          id: p.id,
          name: p.name,
          displayName: p.displayName,
          useCase: p.useCase,
          defaultModel: p.defaultModel,
          isDefaultJudge: p.isDefaultJudge,
          isEnabled: p.isEnabled,
        })),
        dimensions: dimensions.map(d => ({
          code: d.code,
          name: d.name,
          category: d.category,
          description: d.description,
        })),
      },
    });
  } catch (error) {
    console.error('获取裁判模型辅助数据失败:', error);
    return NextResponse.json(
      { success: false, error: '获取数据失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'judge.helper.read',
    rateLimitPolicy: {
      id: 'judge-helper-read',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getJudgeHelpers,
);
