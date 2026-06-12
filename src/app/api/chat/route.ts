import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { llmProviders } from '@/lib/db';
import { eq, and } from 'drizzle-orm';

// 调用 LLM API
async function callLLMApi(
  provider: typeof llmProviders.$inferSelect,
  messages: Array<{ role: string; content: string }>,
  apiKey: string
): Promise<{ content: string; latencyMs: number }> {
  const startTime = Date.now();
  
  let baseUrl = provider.baseUrl || 'https://api.openai.com/v1';
  // 确保 baseUrl 不以 / 结尾
  if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
  
  const model = provider.defaultModel || 'gpt-3.5-turbo';
  
  // 构建请求体
  const requestBody: any = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: 2000,
  };
  
  // 根据供应商类型调整请求
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  
  // 特殊处理不同的供应商
  switch (provider.providerType) {
    case 'deepseek':
      baseUrl = provider.baseUrl || 'https://api.deepseek.com/v1';
      break;
    case 'kimi':
      baseUrl = provider.baseUrl || 'https://api.moonshot.cn/v1';
      break;
    case 'doubao':
      baseUrl = provider.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3';
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'qwen':
      baseUrl = provider.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      break;
    case 'ollama':
      baseUrl = provider.baseUrl || 'http://localhost:11434';
      delete headers['Authorization']; // Ollama不需要API Key
      break;
  }
  
  // 根据provider类型选择API端点和格式
  const isOllama = provider.providerType === 'ollama';
  // Ollama使用OpenAI兼容API (/v1/chat/completions)
  const endpoint = isOllama ? `${baseUrl}/v1/chat/completions` : `${baseUrl}/chat/completions`;
  const ollamaBody = isOllama ? { ...requestBody, stream: false } : requestBody;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API 错误 (${response.status}): ${errorText}`);
  }
  
  const data = await response.json();
  const latencyMs = Date.now() - startTime;
  
  // 提取响应内容（兼容Ollama原生API和OpenAI格式）
  const content = data.choices?.[0]?.message?.content || data.message?.content || '';
  
  return { content, latencyMs };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { providerId, messages, text } = body;
    
    // 如果直接提供文本，转换为消息格式
    const chatMessages = messages || [
      { role: 'user', content: text }
    ];
    
    if (!chatMessages || chatMessages.length === 0) {
      return NextResponse.json(
        { success: false, error: '缺少消息内容' },
        { status: 400 }
      );
    }
    
    // 获取供应商配置
    let provider;
    
    if (providerId) {
      const providers = await db
        .select()
        .from(llmProviders)
        .where(and(
          eq(llmProviders.id, providerId),
          eq(llmProviders.isEnabled, true)
        ))
        .limit(1);
      
      provider = providers[0];
    } else {
      // 如果没有指定供应商，使用默认目标模型
      const providers = await db
        .select()
        .from(llmProviders)
        .where(and(
          eq(llmProviders.isDefaultTarget, true),
          eq(llmProviders.isEnabled, true)
        ))
        .limit(1);
      
      provider = providers[0];
      
      // 如果没有默认目标模型，选择第一个可用的
      if (!provider) {
        const allProviders = await db
          .select()
          .from(llmProviders)
          .where(eq(llmProviders.isEnabled, true))
          .limit(1);
        
        provider = allProviders[0];
      }
    }
    
    if (!provider) {
      return NextResponse.json(
        { success: false, error: '没有可用的模型供应商，请先在"模型供应商管理"中添加配置' },
        { status: 400 }
      );
    }
    
    // Ollama不需要API Key
    if (provider.providerType !== 'ollama' && !provider.apiKeyEncrypted) {
      return NextResponse.json(
        { success: false, error: `供应商 "${provider.displayName}" 未配置 API Key` },
        { status: 400 }
      );
    }
    
    // 调用 LLM API
    const { content, latencyMs } = await callLLMApi(provider, chatMessages, provider.apiKeyEncrypted);
    
    return NextResponse.json({
      success: true,
      data: {
        provider: {
          id: provider.id,
          name: provider.name,
          displayName: provider.displayName,
          model: provider.defaultModel,
        },
        response: content,
        latencyMs,
      },
    });
    
  } catch (error: any) {
    console.error('调用 LLM 失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '调用 LLM 失败' },
      { status: 500 }
    );
  }
}

// 获取可用的目标模型列表
export async function GET() {
  try {
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
      .where(eq(llmProviders.isEnabled, true));
    
    // 过滤出可用于目标模型的供应商
    const targetProviders = providers.filter(
      p => p.useCase === 'target' || p.useCase === 'both'
    );
    
    return NextResponse.json({
      success: true,
      data: targetProviders,
    });
    
  } catch (error) {
    console.error('获取模型列表失败:', error);
    return NextResponse.json(
      { success: false, error: '获取模型列表失败' },
      { status: 500 }
    );
  }
}
