import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

interface TestResult {
  success: boolean;
  latencyMs: number;
  error?: string;
  modelResponse?: string;
}

async function testOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<TestResult> {
  const startTime = Date.now();
  
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10,
      }),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        latencyMs,
        error: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      latencyMs,
      modelResponse: data.choices?.[0]?.message?.content || 'OK',
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : '连接失败',
    };
  }
}

async function testOllama(baseUrl: string, model: string): Promise<TestResult> {
  const startTime = Date.now();
  
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
      }),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        latencyMs,
        error: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      latencyMs,
      modelResponse: data.message?.content || 'OK',
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : '连接失败',
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { providerId } = body;

    if (!providerId) {
      return NextResponse.json(
        { success: false, error: '缺少 Provider ID' },
        { status: 400 }
      );
    }

    const client = getDb();
    
    // 获取 Provider 配置
    const { data: providers, error: fetchError } = await client
      .from('llm_providers')
      .select()
      .eq('id', providerId)
      .limit(1);

    if (fetchError || !providers || providers.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Provider 不存在' },
        { status: 404 }
      );
    }

    const provider = providers[0];
    const { providerType, baseUrl, apiKeyEncrypted, defaultModel } = provider;

    // 根据不同类型测试连接
    let testResult: TestResult;

    switch (providerType) {
      case 'ollama':
        testResult = await testOllama(
          baseUrl || 'http://localhost:11434',
          defaultModel || 'llama2'
        );
        break;

      case 'openai_compatible':
      case 'deepseek':
      case 'kimi':
      case 'doubao':
      case 'qwen':
      case 'custom':
        if (!apiKeyEncrypted) {
          testResult = {
            success: false,
            latencyMs: 0,
            error: '未配置 API Key',
          };
        } else {
          testResult = await testOpenAICompatible(
            baseUrl || 'https://api.openai.com/v1',
            apiKeyEncrypted,
            defaultModel || 'gpt-3.5-turbo'
          );
        }
        break;

      case 'coze':
        // Coze Bot 测试
        if (!apiKeyEncrypted) {
          testResult = {
            success: false,
            latencyMs: 0,
            error: '未配置 API Key',
          };
        } else {
          testResult = await testOpenAICompatible(
            baseUrl || 'https://api.coze.cn/v1',
            apiKeyEncrypted,
            defaultModel || 'default'
          );
        }
        break;

      default:
        testResult = {
          success: false,
          latencyMs: 0,
          error: `不支持的 Provider 类型: ${providerType}`,
        };
    }

    // 更新测试结果到数据库
    const now = new Date();
    await client
      .from('llm_providers')
      .update({
        lastTestAt: now,
        lastTestSuccess: testResult.success,
        avgLatencyMs: testResult.latencyMs,
        updatedAt: now,
      })
      .eq('id', providerId);

    return NextResponse.json({
      success: true,
      data: {
        providerId,
        testSuccess: testResult.success,
        latencyMs: testResult.latencyMs,
        error: testResult.error,
        modelResponse: testResult.modelResponse,
      },
    });
  } catch (error) {
    console.error('测试 Provider 连接失败:', error);
    return NextResponse.json(
      { success: false, error: '测试连接失败' },
      { status: 500 }
    );
  }
}
