import { afterEach, describe, expect, it, vi } from 'vitest';
import { EgressRequestError, safeFetchJson } from '../../src/lib/egress';
import { callProviderChat, type ProviderConnection } from '../../src/lib/providers/chat';
import { providerConnectionTestOptions, providerTestFailure } from '../../src/lib/providers/connection-test';

vi.mock('../../src/lib/egress', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/lib/egress')>(),
  safeFetchJson: vi.fn(),
}));

afterEach(() => { vi.clearAllMocks(); });

const connection: ProviderConnection = {
  tenantId: 'test-tenant', applicationId: 'test-app', providerType: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.3',
  secretRef: 'synthetic-reference', apiKeyEncrypted: null,
};

describe('provider connection tests', () => {
  it.each([
    ['https://open.bigmodel.cn/api/paas/v4', 'chat/completions'],
    ['https://open.bigmodel.cn/api/paas/v4/', 'chat/completions'],
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'chat/completions'],
    ['https://api.openai.com/v1', 'chat/completions'],
    ['https://ark.cn-beijing.volces.com/api/v3', 'chat/completions'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'chat/completions'],
  ])('preserves versioned base URL %s', async (baseUrl, path) => {
    vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: 'OK' } }] });
    const result = await callProviderChat({ ...connection, baseUrl }, [{ role: 'user', content: 'synthetic' }], {
      ...providerConnectionTestOptions(connection),
      secretProvider: { put: vi.fn(), get: vi.fn(async () => 'synthetic-secret'), delete: vi.fn() },
    });
    expect(result.content).toBe('OK');
    expect(safeFetchJson).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl, path,
      body: expect.objectContaining({ model: 'glm-5.3', max_tokens: 1024, thinking: { type: 'enabled' }, reasoning_effort: 'low' }),
    }));
    expect(vi.mocked(safeFetchJson).mock.calls[0][0].body).not.toHaveProperty('temperature');
  });

  it.each([
    // Endpoints pasted with the full chat route must not append it twice.
    ['glm', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'https://open.bigmodel.cn/api/paas/v4', 'chat/completions'],
    ['deepseek', 'https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1', 'chat/completions'],
    // Bare hosts carry no OpenAI-style /v1 on Zhipu, Ark or DashScope.
    ['glm', 'https://open.bigmodel.cn', 'https://open.bigmodel.cn', 'api/paas/v4/chat/completions'],
    ['doubao', 'https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com', 'api/v3/chat/completions'],
    ['qwen', 'https://dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com', 'compatible-mode/v1/chat/completions'],
    ['deepseek', 'https://api.deepseek.com', 'https://api.deepseek.com', 'v1/chat/completions'],
  ])('normalizes %s endpoint %s', async (providerType, configured, baseUrl, path) => {
    vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: 'OK' } }] });
    await callProviderChat({ ...connection, providerType, baseUrl: configured, defaultModel: 'synthetic-model' }, [{ role: 'user', content: 'synthetic' }], {
      secretProvider: { put: vi.fn(), get: vi.fn(async () => 'synthetic-secret'), delete: vi.fn() },
    });
    expect(safeFetchJson).toHaveBeenCalledWith(expect.objectContaining({ baseUrl, path }));
  });

  it.each([
    ['qwen', 'disabled', { enable_thinking: false }],
    ['qwen', 'enabled', { enable_thinking: true }],
    ['glm', 'disabled', { thinking: { type: 'disabled' } }],
    ['doubao', 'enabled', { thinking: { type: 'enabled' } }],
    ['ollama', 'disabled', { reasoning_effort: 'none' }],
    // DeepSeek has no switch and OpenAI rejects unknown fields: omit entirely.
    ['deepseek', 'disabled', {}],
    ['openai_compatible', 'enabled', {}],
  ])('maps thinking %s:%s onto the vendor dialect', async (providerType, mode, expected) => {
    vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: 'OK' } }] });
    await callProviderChat({ ...connection, providerType, baseUrl: 'https://llm.example.com/v1' }, [{ role: 'user', content: 'synthetic' }], {
      thinkingMode: mode as 'enabled' | 'disabled',
      secretProvider: { put: vi.fn(), get: vi.fn(async () => 'synthetic-secret'), delete: vi.fn() },
    });
    const body = vi.mocked(safeFetchJson).mock.calls[0][0].body as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) expect(body).toMatchObject({ [key]: value });
    for (const key of ['thinking', 'enable_thinking', 'reasoning_effort']) {
      if (!(key in expected)) expect(body).not.toHaveProperty(key);
    }
  });

  it('reports an empty response rather than an invalid schema when content is null', async () => {
    vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: null } }] });
    await expect(callProviderChat(connection, [{ role: 'user', content: 'synthetic' }], {
      secretProvider: { put: vi.fn(), get: vi.fn(async () => 'synthetic-secret'), delete: vi.fn() },
    })).rejects.toThrowError(expect.objectContaining({ code: 'PROVIDER_RESPONSE_EMPTY' }));
  });

  it.each([
    ['glm', 'glm-4.6'],
    ['deepseek', 'deepseek-reasoner'],
    ['deepseek', 'deepseek-r1-distill-qwen-7b'],
    ['qwen', 'qwen3-235b-a22b'],
    ['qwen', 'qwq-32b'],
    ['doubao', 'doubao-seed-1.6-flash'],
    ['kimi', 'kimi-k2-thinking'],
    ['ollama', 'qwen3:14b'],
  ])('probes thinking model %s with a full output budget', (providerType, defaultModel) => {
    expect(providerConnectionTestOptions({ providerType, defaultModel }))
      .toEqual({ maxTokens: 1_024, temperature: null, timeoutMs: 30_000 });
  });

  it('uses a short probe for other models', () => {
    expect(providerConnectionTestOptions({ providerType: 'deepseek', defaultModel: 'deepseek-chat' }))
      .toEqual({ maxTokens: 10, temperature: 0, timeoutMs: 10000 });
    expect(providerConnectionTestOptions({ providerType: 'glm', defaultModel: 'glm-4-flash' }))
      .toEqual({ maxTokens: 10, temperature: 0, timeoutMs: 10000 });
  });

  it('distinguishes the Zhipu balance error from generic throttling without exposing messages', () => {
    const balance = providerTestFailure(new EgressRequestError('UPSTREAM_HTTP_ERROR', 'secret-must-not-escape', 429, '1113'));
    expect(balance).toMatchObject({ errorCode: 'UPSTREAM_HTTP_ERROR', upstreamStatus: 429, upstreamCode: '1113' });
    expect(balance.errorMessage).toContain('余额不足');
    expect(JSON.stringify(balance)).not.toContain('secret-must-not-escape');
    const throttled = providerTestFailure(new EgressRequestError('UPSTREAM_HTTP_ERROR', 'private', 429));
    expect(throttled.upstreamCode).toBeUndefined();
    expect(throttled.errorMessage).toContain('限流或额度不足');
  });

  it.each([
    [404, undefined, '接口不存在'],
    [401, undefined, '认证失败'],
    [400, '1211', '模型标识'],
    [400, '1309', '套餐已过期'],
  ])('explains status %s and code %s', (status, code, expected) => {
    expect(providerTestFailure(new EgressRequestError('UPSTREAM_HTTP_ERROR', 'private', status, code)).errorMessage).toContain(expected);
  });

  it('does not expose an unexpected exception', () => {
    expect(providerTestFailure(new Error('api-key-must-not-escape'))).toEqual({
      errorCode: 'PROVIDER_TEST_FAILED', errorMessage: '模型连接测试失败，请根据错误码检查服务配置。',
    });
  });
});
