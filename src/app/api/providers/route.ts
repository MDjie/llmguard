import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// GET - 获取所有 LLM Provider
export async function GET(request: NextRequest) {
  try {
    const client = getDb();
    
    const { data: providers, error } = await client
      .from('llm_providers')
      .select()
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    // 隐藏 API Key 的敏感信息
    const sanitizedProviders = (providers || []).map((provider: any) => ({
      ...provider,
      apiKeyEncrypted: provider.apiKeyEncrypted ? '******' : null,
    }));

    return NextResponse.json({
      success: true,
      data: sanitizedProviders,
    });
  } catch (error) {
    console.error('获取 LLM Provider 列表失败:', error);
    return NextResponse.json(
      { success: false, error: '获取 LLM Provider 列表失败' },
      { status: 500 }
    );
  }
}

// POST - 创建新的 LLM Provider
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, displayName, providerType, baseUrl, apiKey, defaultModel, useCase } = body;

    if (!name || !displayName || !providerType) {
      return NextResponse.json(
        { success: false, error: '缺少必填字段' },
        { status: 400 }
      );
    }

    const client = getDb();

    const result = await client
      .from('llm_providers')
      .insert({
        name,
        displayName,
        providerType,
        baseUrl,
        apiKeyEncrypted: apiKey,
        defaultModel,
        useCase: useCase || 'both',
        isEnabled: true,
      });

    if (result.error) {
      throw result.error;
    }

    // 返回插入的数据
    const provider = result.data;

    return NextResponse.json({
      success: true,
      data: provider,
    });
  } catch (error) {
    console.error('创建 LLM Provider 失败:', error);
    return NextResponse.json(
      { success: false, error: '创建 LLM Provider 失败' },
      { status: 500 }
    );
  }
}

// PUT - 更新 LLM Provider
export async function PUT(request: NextRequest) {
  try {
    // 从 URL 参数获取 id
    const { searchParams } = new URL(request.url);
    const urlId = searchParams.get('id');

    // 尝试从请求体获取数据
    let body = {};
    try {
      body = await request.json();
    } catch {
      // 请求体为空，使用空对象
    }

    const { id: bodyId, ...updates }: { id?: string; [key: string]: unknown } = body;
    const id = urlId || bodyId;

    if (!id) {
      return NextResponse.json(
        { success: false, error: '缺少 Provider ID' },
        { status: 400 }
      );
    }

    const client = getDb();

    const updateData: any = {};

    if (updates.displayName) updateData.displayName = updates.displayName;
    if (updates.providerType) updateData.providerType = updates.providerType;
    if (updates.baseUrl !== undefined) updateData.baseUrl = updates.baseUrl;
    if (updates.apiKey !== undefined) updateData.apiKeyEncrypted = updates.apiKey;
    if (updates.defaultModel !== undefined) updateData.defaultModel = updates.defaultModel;
    if (updates.useCase) updateData.useCase = updates.useCase;
    if (updates.isEnabled !== undefined) updateData.isEnabled = updates.isEnabled;
    if (updates.isDefaultTarget !== undefined) updateData.isDefaultTarget = updates.isDefaultTarget;
    if (updates.isDefaultJudge !== undefined) updateData.isDefaultJudge = updates.isDefaultJudge;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { success: false, error: '没有要更新的字段' },
        { status: 400 }
      );
    }

    const { error } = await client
      .from('llm_providers')
      .update(updateData)
      .eq('id', id);

    if (error) {
      throw error;
    }

    return NextResponse.json({
      success: true,
      message: '更新成功',
    });
  } catch (error) {
    console.error('更新 LLM Provider 失败:', error);
    return NextResponse.json(
      { success: false, error: '更新 LLM Provider 失败' },
      { status: 500 }
    );
  }
}

// DELETE - 删除 LLM Provider
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: '缺少 Provider ID' },
        { status: 400 }
      );
    }

    const client = getDb();

    const { error } = await client
      .from('llm_providers')
      .delete()
      .eq('id', id);

    if (error) {
      throw error;
    }

    return NextResponse.json({
      success: true,
      message: '删除成功',
    });
  } catch (error) {
    console.error('删除 LLM Provider 失败:', error);
    return NextResponse.json(
      { success: false, error: '删除 LLM Provider 失败' },
      { status: 500 }
    );
  }
}
