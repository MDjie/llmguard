import { describe, expect, it } from 'vitest';
import { LLMGateway } from '../../src/lib/llm/gateway';
import type { LLMProvider } from '../../src/lib/llm/types';
import {
  parseProviderType,
  ProviderConfigurationError,
  providerBaseUrl,
} from '../../src/lib/providers';

function provider(providerType: LLMProvider['providerType']): LLMProvider {
  return {
    id: `provider-${providerType}`,
    name: `Provider ${providerType}`,
    providerType,
    baseUrl: 'https://llm.example.com/v1',
    defaultModel: 'test-model',
    isEnabled: true,
    useCase: 'both',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('provider type registry', () => {
  it('rejects removed or unknown provider types at the boundary', () => {
    expect(() => parseProviderType('coze')).toThrowError(
      expect.objectContaining<Partial<ProviderConfigurationError>>({
        code: 'PROVIDER_TYPE_UNSUPPORTED',
      }),
    );
    expect(() => parseProviderType('unknown')).toThrowError(ProviderConfigurationError);
  });

  it('requires an explicit endpoint for custom OpenAI-compatible providers', () => {
    expect(parseProviderType('custom')).toBe('custom');
    expect(() => providerBaseUrl('custom', null)).toThrowError(
      expect.objectContaining<Partial<ProviderConfigurationError>>({
        code: 'PROVIDER_BASE_URL_REQUIRED',
      }),
    );
  });

  it('registers custom providers with a functional OpenAI-compatible adapter', () => {
    const gateway = new LLMGateway();
    gateway.registerProvider(provider('custom'));

    expect(gateway.getProvider('provider-custom')).toMatchObject({
      providerType: 'custom',
      name: 'Provider custom',
    });
  });
});
