/**
 * OpenAI-Compatible Provider Adapter
 * 
 * 支持所有兼容 OpenAI API 格式的大模型：
 * - DeepSeek
 * - Kimi
 * - 豆包
 * - 通义千问
 * - 智谱 GLM
 * - Ollama
 * - 其他 OpenAI-Compatible API
 */

import type {
  IProviderAdapter,
  ProviderType,
  LLMChatRequest,
  LLMChatResponse,
  LLMTestConnectionResult,
} from '../types';

export class OpenAICompatibleAdapter implements IProviderAdapter {
  readonly name: string;
  readonly providerType: ProviderType = 'openai_compatible';
  
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(
    name: string,
    baseUrl: string,
    apiKey: string,
    defaultModel: string
  ) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, ''); // 移除末尾的斜杠
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  /**
   * 调用 LLM API
   */
  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const startTime = Date.now();

    // 构建请求 URL - Ollama用 /v1/chat/completions，其他用 /v1/chat/completions
    // 如果baseUrl已经包含/v1就直接加 /chat/completions，否则加 /v1/chat/completions
    const url = this.baseUrl.includes('/v1') 
      ? `${this.baseUrl}/chat/completions` 
      : `${this.baseUrl}/v1/chat/completions`;

    // 构建请求体
    const body = {
      model: request.model || this.defaultModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 2048,
      top_p: request.topP,
      stream: false, // 不支持流式
    };

    // 构建请求头
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // 如果有 API Key，添加到请求头
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // 发送请求
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // 检查响应状态
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API call failed: ${response.status} - ${errorText}`);
    }

    // 解析响应
    const data = await response.json();

    // 提取响应内容
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage;

    return {
      id: data.id || `chat-${Date.now()}`,
      content,
      model: request.model || this.defaultModel,
      provider: this.name,
      providerType: this.providerType,
      latencyMs: Date.now() - startTime,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
          }
        : undefined,
      raw: data,
    };
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<LLMTestConnectionResult> {
    const startTime = Date.now();

    try {
      // 发送一个简单的测试请求
      await this.chat({
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 10,
      });

      return {
        success: true,
        message: 'Connection successful',
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
        latencyMs: Date.now() - startTime,
      };
    }
  }
}

/**
 * DeepSeek Adapter
 */
export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  readonly providerType: ProviderType = 'deepseek';

  constructor(apiKey: string, model: string = 'deepseek-chat') {
    super('DeepSeek', 'https://api.deepseek.com', apiKey, model);
  }
}

/**
 * Kimi Adapter
 */
export class KimiAdapter extends OpenAICompatibleAdapter {
  readonly providerType: ProviderType = 'kimi';

  constructor(apiKey: string, model: string = 'moonshot-v1-8k') {
    super('Kimi', 'https://api.moonshot.cn', apiKey, model);
  }
}

/**
 * 豆包 Adapter
 */
export class DoubaoAdapter extends OpenAICompatibleAdapter {
  readonly providerType: ProviderType = 'doubao';

  constructor(apiKey: string, model: string = 'doubao-pro-4k') {
    super('豆包', 'https://ark.cn-beijing.volces.com/api/v3', apiKey, model);
  }
}

/**
 * 通义千问 Adapter
 */
export class QwenAdapter extends OpenAICompatibleAdapter {
  readonly providerType: ProviderType = 'qwen';

  constructor(apiKey: string, model: string = 'qwen-turbo') {
    super('通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey, model);
  }
}

/**
 * 智谱 GLM Adapter
 */
export class GLMAdapter extends OpenAICompatibleAdapter {
  readonly providerType: ProviderType = 'glm';

  constructor(apiKey: string, model: string = 'glm-4') {
    super('智谱GLM', 'https://open.bigmodel.cn/api/paas/v4', apiKey, model);
  }
}

/**
 * Ollama Adapter（本地模型）
 */
export class OllamaAdapter extends OpenAICompatibleAdapter {
  readonly providerType: ProviderType = 'ollama';

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'llama2') {
    super('Ollama', baseUrl, '', model);
  }
}
