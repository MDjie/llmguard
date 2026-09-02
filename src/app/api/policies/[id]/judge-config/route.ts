import { NextRequest, NextResponse } from 'next/server';
import {
  emptyQuerySchema,
  jsonObjectResponseSchema,
} from '@/contracts/http/common';
import { judgeConfigSchema, policyParamsSchema } from '@/contracts/http/policies';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { policyJudgeConfigs, llmProviders, policyProfiles } from '@/storage/database/shared/schema';
import { and, eq } from 'drizzle-orm';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

// GET: 获取策略的裁判模型配置
async function getJudgeConfig(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    const { id: policyId } = await params;

    // 查询裁判模型配置
    const configs = await db
      .select()
      .from(policyJudgeConfigs)
      .where(and(
        eq(policyJudgeConfigs.policyId, policyId),
        scopePredicate(policyJudgeConfigs, scope),
      ))
      .limit(1);

    if (configs.length === 0) {
      // 返回默认配置
      return NextResponse.json({
        success: true,
        data: {
          id: '',
          policyId,
          enabled: false,
          providerId: null,
          mode: 'conservative',
          triggerMode: 'risk_or_semantic',
          triggerThreshold: 40,
          judgeThreshold: 70,
          weight: 0.5,
          applyToInput: true,
          applyToOutput: true,
          enabledDimensions: [],
          semanticDimensions: [],
          timeoutMs: 8000,
          fallbackAction: 'rule',
          failClosedForHighRisk: true,
          maxTextLength: 6000,
          maskPiiBeforeJudge: true,
          blockExternalForSecrets: true,
        },
      });
    }

    const config = configs[0];

    return NextResponse.json({
      success: true,
      data: {
        id: config.id,
        policyId: config.policyId,
        enabled: config.enabled,
        providerId: config.providerId,
        mode: config.mode,
        triggerMode: config.triggerMode,
        triggerThreshold: config.triggerThreshold,
        judgeThreshold: config.judgeThreshold,
        weight: parseFloat(config.weight || '0.5'),
        applyToInput: config.applyToInput,
        applyToOutput: config.applyToOutput,
        enabledDimensions: Array.isArray(config.enabledDimensions) ? config.enabledDimensions : [],
        semanticDimensions: Array.isArray(config.semanticDimensions) ? config.semanticDimensions : [],
        timeoutMs: config.timeoutMs,
        fallbackAction: config.fallbackAction,
        failClosedForHighRisk: config.failClosedForHighRisk,
        maxTextLength: config.maxTextLength,
        maskPiiBeforeJudge: config.maskPiiBeforeJudge,
        blockExternalForSecrets: config.blockExternalForSecrets,
        createdAt: config.createdAt?.toISOString?.() || undefined,
        updatedAt: config.updatedAt?.toISOString?.() || undefined,
      },
    });
  } catch (error) {
    console.error('获取裁判模型配置失败:', error);
    return NextResponse.json(
      { success: false, error: '获取配置失败' },
      { status: 500 }
    );
  }
}

// PUT: 更新或创建裁判模型配置
async function updateJudgeConfig(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    const { id: policyId } = await params;
    const body = await request.json();
    const [policy] = await db.select({ id: policyProfiles.id }).from(policyProfiles).where(and(
      eq(policyProfiles.id, policyId),
      scopePredicate(policyProfiles, scope),
    )).limit(1);
    if (!policy) {
      return NextResponse.json({ success: false, error: '策略不属于当前应用' }, { status: 404 });
    }

    // 验证必填字段
    const {
      enabled,
      providerId,
      mode,
      triggerMode,
      triggerThreshold,
      judgeThreshold,
      weight,
      applyToInput,
      applyToOutput,
      enabledDimensions,
      semanticDimensions,
      timeoutMs,
      fallbackAction,
      failClosedForHighRisk,
      maxTextLength,
      maskPiiBeforeJudge,
      blockExternalForSecrets,
    } = body;

    // 如果启用且指定了 provider，验证 provider 是否存在且可用作裁判模型
    if (enabled && providerId) {
      const providers = await db
        .select()
        .from(llmProviders)
        .where(and(
          eq(llmProviders.id, providerId),
          scopePredicate(llmProviders, scope),
        ))
        .limit(1);

      if (providers.length === 0) {
        return NextResponse.json(
          { success: false, error: '指定的模型供应商不存在' },
          { status: 400 }
        );
      }

      if (!providers[0].isEnabled) {
        return NextResponse.json(
          { success: false, error: '指定的模型供应商已关闭，请先在模型管理中启用' },
          { status: 400 }
        );
      }

      const provider = providers[0];
      if (provider.useCase !== 'judge' && provider.useCase !== 'both') {
        return NextResponse.json(
          { success: false, error: '指定的模型供应商不支持裁判模型用途' },
          { status: 400 }
        );
      }
    }

    // 检查是否已存在配置
    const existingConfigs = await db
      .select()
      .from(policyJudgeConfigs)
      .where(and(
        eq(policyJudgeConfigs.policyId, policyId),
        scopePredicate(policyJudgeConfigs, scope),
      ))
      .limit(1);

    if (existingConfigs.length > 0) {
      // 更新现有配置
      await db
        .update(policyJudgeConfigs)
        .set({
          enabled: enabled ?? false,
          providerId: providerId || null,
          mode: mode || 'conservative',
          triggerMode: triggerMode || 'risk_or_semantic',
          triggerThreshold: triggerThreshold ?? 40,
          judgeThreshold: judgeThreshold ?? 70,
          weight: (weight ?? 0.5).toString(),
          applyToInput: applyToInput ?? true,
          applyToOutput: applyToOutput ?? true,
          enabledDimensions: enabledDimensions || [],
          semanticDimensions: semanticDimensions || [],
          timeoutMs: timeoutMs ?? 8000,
          fallbackAction: fallbackAction || 'rule',
          failClosedForHighRisk: failClosedForHighRisk ?? true,
          maxTextLength: maxTextLength ?? 6000,
          maskPiiBeforeJudge: maskPiiBeforeJudge ?? true,
          blockExternalForSecrets: blockExternalForSecrets ?? true,
          updatedAt: new Date(),
        })
        .where(and(
          eq(policyJudgeConfigs.id, existingConfigs[0].id),
          scopePredicate(policyJudgeConfigs, scope),
        ));

      return NextResponse.json({
        success: true,
        message: '裁判模型配置已更新',
      });
    } else {
      // 创建新配置
      await db.insert(policyJudgeConfigs).values({
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        policyId,
        enabled: enabled ?? false,
        providerId: providerId || null,
        mode: mode || 'conservative',
        triggerMode: triggerMode || 'risk_or_semantic',
        triggerThreshold: triggerThreshold ?? 40,
        judgeThreshold: judgeThreshold ?? 70,
        weight: (weight ?? 0.5).toString(),
        applyToInput: applyToInput ?? true,
        applyToOutput: applyToOutput ?? true,
        enabledDimensions: enabledDimensions || [],
        semanticDimensions: semanticDimensions || [],
        timeoutMs: timeoutMs ?? 8000,
        fallbackAction: fallbackAction || 'rule',
        failClosedForHighRisk: failClosedForHighRisk ?? true,
        maxTextLength: maxTextLength ?? 6000,
        maskPiiBeforeJudge: maskPiiBeforeJudge ?? true,
        blockExternalForSecrets: blockExternalForSecrets ?? true,
      });

      return NextResponse.json({
        success: true,
        message: '裁判模型配置已创建',
      });
    }
  } catch (error) {
    console.error('保存裁判模型配置失败:', error);
    return NextResponse.json(
      { success: false, error: '保存配置失败' },
      { status: 500 }
    );
  }
}

// DELETE: 删除裁判模型配置
async function deleteJudgeConfig(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    const { id: policyId } = await params;

    await db
      .delete(policyJudgeConfigs)
      .where(and(
        eq(policyJudgeConfigs.policyId, policyId),
        scopePredicate(policyJudgeConfigs, scope),
      ));

    return NextResponse.json({
      success: true,
      message: '裁判模型配置已删除',
    });
  } catch (error) {
    console.error('删除裁判模型配置失败:', error);
    return NextResponse.json(
      { success: false, error: '删除配置失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: policyParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'policy.judge.read',
    rateLimitPolicy: {
      id: 'policy-judge-read',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getJudgeConfig,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: judgeConfigSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 32 * 1_024,
    auditEvent: 'policy.judge.update',
    rateLimitPolicy: {
      id: 'policy-judge-update',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  updateJudgeConfig,
);

export const DELETE = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'policy.judge.delete',
    rateLimitPolicy: {
      id: 'policy-judge-delete',
      windowMs: 60_000,
      maxRequests: 10,
      scope: 'principal',
    },
  },
  deleteJudgeConfig,
);
