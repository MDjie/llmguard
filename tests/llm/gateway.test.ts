import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../../src/lib/llm/types';

const mocks = vi.hoisted(() => ({
  safeFetchJson: vi.fn(),
}));

vi.mock('@/lib/egress', () => ({
  safeFetchJson: mocks.safeFetchJson,
}));

import {
  getLLMGateway,
  LLMGateway,
  resetLLMGateway,
} from '../../src/lib/llm/gateway';

function provider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    id: 'provider-1',
    name: 'Test provider',
    providerType: 'openai_compatible',
    baseUrl: 'https://llm.example.test',
    apiKey: 'secret-key',
    defaultModel: 'model-default',
    isEnabled: true,
    useCase: 'both',
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.safeFetchJson.mockReset();
  resetLLMGateway();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LLM gateway', () => {
  it('registers providers and maps a validated chat response', async () => {
    mocks.safeFetchJson.mockResolvedValue({
      id: 'chat-1',
      choices: [{ message: { content: 'safe answer' } }],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      },
    });
    const gateway = new LLMGateway({ maxRetries: 1, timeoutMs: 1_000 });
    gateway.registerProvider(provider());

    const response = await gateway.chat('provider-1', {
      model: '',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(response).toMatchObject({
      id: 'chat-1',
      content: 'safe answer',
      model: 'model-default',
      provider: 'Test provider',
      providerType: 'openai_compatible',
      usage: {
        promptTokens: 4,
        completionTokens: 2,
        totalTokens: 6,
      },
    });
    expect(mocks.safeFetchJson).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://llm.example.test',
      path: 'v1/chat/completions',
      providerType: 'openai_compatible',
      headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      body: expect.objectContaining({
        model: 'model-default',
        temperature: 0.3,
        max_tokens: 2048,
        stream: false,
      }),
      signal: expect.any(AbortSignal),
    }));
  });

  it('retries transient provider failures and preserves the final error', async () => {
    mocks.safeFetchJson
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'recovered' } }],
      });
    const gateway = new LLMGateway({
      maxRetries: 2,
      retryDelayMs: 0,
      timeoutMs: 1_000,
    });
    gateway.registerProvider(provider());

    await expect(gateway.chat('provider-1', {
      model: 'model-a',
      messages: [{ role: 'user', content: 'retry' }],
    })).resolves.toMatchObject({ content: 'recovered' });
    expect(mocks.safeFetchJson).toHaveBeenCalledTimes(2);

    mocks.safeFetchJson.mockReset();
    mocks.safeFetchJson.mockRejectedValue(new Error('permanent failure'));
    await expect(gateway.chat('provider-1', {
      model: 'model-a',
      messages: [{ role: 'user', content: 'fail' }],
    })).rejects.toThrow('permanent failure');
  });

  it('stops retry delay when the caller aborts', async () => {
    mocks.safeFetchJson.mockRejectedValue(new Error('network failure'));
    const gateway = new LLMGateway({
      maxRetries: 2,
      retryDelayMs: 10,
      timeoutMs: 1_000,
    });
    gateway.registerProvider(provider());
    const controller = new AbortController();
    controller.abort();

    await expect(gateway.chat('provider-1', {
      model: 'model-a',
      messages: [{ role: 'user', content: 'cancel' }],
      signal: controller.signal,
    })).rejects.toThrow('Provider request was aborted');
    expect(mocks.safeFetchJson).toHaveBeenCalledOnce();
  });

  it('rejects invalid provider payloads and reports connection failures', async () => {
    mocks.safeFetchJson.mockResolvedValue({ choices: [] });
    const gateway = new LLMGateway({ maxRetries: 1 });
    gateway.registerProvider(provider());

    await expect(gateway.chat('provider-1', {
      model: 'model-a',
      messages: [{ role: 'user', content: 'invalid' }],
    })).rejects.toThrow('LLM provider response schema is invalid');
    await expect(gateway.testConnection('provider-1')).resolves.toMatchObject({
      success: false,
      message: 'LLM provider response schema is invalid',
    });
  });

  it('handles missing providers, removal, bulk registration, and singleton reset', async () => {
    const gateway = new LLMGateway();
    gateway.registerProviders([
      provider(),
      provider({
        id: 'ollama',
        name: 'Local Ollama',
        providerType: 'ollama',
        baseUrl: '',
        apiKey: undefined,
      }),
    ]);

    expect(gateway.listProviders()).toEqual(['provider-1', 'ollama']);
    expect(gateway.getProvider('ollama')?.providerType).toBe('ollama');
    expect(gateway.removeProvider('ollama')).toBe(true);
    expect(gateway.removeProvider('ollama')).toBe(false);
    await expect(gateway.chat('missing', {
      model: 'none',
      messages: [],
    })).rejects.toThrow('Provider not found: missing');
    await expect(gateway.testConnection('missing')).resolves.toEqual({
      success: false,
      message: 'Provider not found: missing',
    });

    const singleton = getLLMGateway({ maxRetries: 1 });
    expect(getLLMGateway()).toBe(singleton);
    resetLLMGateway();
    expect(getLLMGateway()).not.toBe(singleton);
  });
});
