import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { llmProviders, detectionDimensions } from '@/storage/database/shared/schema';
import { eq, or } from 'drizzle-orm';

// GET: 获取裁判模型配置所需的辅助数据
export async function GET(request: NextRequest) {
  try {
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
      .from(llmProviders);

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
      .where(eq(detectionDimensions.enabled, true));

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