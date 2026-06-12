import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { policyJudgeConfigs, llmProviders, detectionDimensions } from '@/storage/database/shared/schema';
import { eq, and } from 'drizzle-orm';
import type { PolicyJudgeConfig } from '@/lib/judge/types';

// GET: 获取策略的裁判模型配置
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;

    // 查询裁判模型配置
    const configs = await db
      .select()
      .from(policyJudgeConfigs)
      .where(eq(policyJudgeConfigs.policyId, policyId))
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
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;
    const body = await request.json();

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
        .where(eq(llmProviders.id, providerId))
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
      .where(eq(policyJudgeConfigs.policyId, policyId))
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
        .where(eq(policyJudgeConfigs.id, existingConfigs[0].id));

      return NextResponse.json({
        success: true,
        message: '裁判模型配置已更新',
      });
    } else {
      // 创建新配置
      await db.insert(policyJudgeConfigs).values({
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
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: policyId } = await params;

    await db
      .delete(policyJudgeConfigs)
      .where(eq(policyJudgeConfigs.policyId, policyId));

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