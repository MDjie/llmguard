import { NextResponse } from 'next/server';
import {readMediaCapabilities} from '@/lib/media/capabilities';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { llmProviders } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

/**
 * 获取支持 OCR 的模型列表
 * 从模型供应商管理中获取 useCase='ocr' 的模型
 */
async function getOcrModels(
  request: Request,
  _routeContext: unknown,
  apiContext: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(apiContext.principal);
    // 从数据库获取 useCase='ocr' 且已启用的模型
    const ocrProviders = await db
      .select()
      .from(llmProviders)
      .where(
        and(
          eq(llmProviders.useCase, 'ocr'),
          eq(llmProviders.isEnabled, true),
          scopePredicate(llmProviders, scope),
        )
      );

    const models = ocrProviders.map((provider) => ({
      id: provider.id,
      modelId: provider.defaultModel || provider.name,
      name: provider.displayName,
      providerName: provider.name,
      description: `模型: ${provider.defaultModel || '未指定'}`,
      baseUrl: provider.baseUrl,
      recommended: provider.isDefaultTarget,
    }));

    const media = await readMediaCapabilities(request.signal);
    return NextResponse.json({
      success: true,
      data: {
        models,
        // Legacy provider entries are configuration, not proof of analyzer/model qualification.
        capabilityVersion: media.version,
        formats: media.formats.filter(format => format.category === 'image' || format.category === 'document'),
        limits: {image: media.limits.image, document: media.limits.document},
        analyzer: media.analyzer,
        unavailableReason: media.unavailableReason,
        qualification: media.qualification,
        hasOcrModels: models.length > 0,
        defaultModelId: models.find((m) => m.recommended)?.id || models[0]?.id || null,
      },
    });
  } catch (error) {
    console.error('获取 OCR 模型列表失败:', error);
    return NextResponse.json(
      { success: false, error: '获取 OCR 模型列表失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'provider:read',
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'ocr-model.list',
    rateLimitPolicy: {
      id: 'ocr-model-list',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getOcrModels,
);
