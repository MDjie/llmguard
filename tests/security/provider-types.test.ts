import { describe, expect, it } from 'vitest';
import {
  parseProviderType,
  ProviderConfigurationError,
  providerBaseUrl,
} from '../../src/lib/providers';
import {
  PROVIDER_TYPES,
  providerDescriptor,
  providerRequiresSecret,
} from '../../src/lib/providers/registry';

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

  it('describes every registered type exactly once', () => {
    expect(new Set(PROVIDER_TYPES).size).toBe(PROVIDER_TYPES.length);
    for (const type of PROVIDER_TYPES) {
      expect(providerDescriptor(type)).toMatchObject({ type, label: expect.any(String) });
    }
    expect(providerDescriptor('coze')).toBeUndefined();
  });

  it('fails closed for unregistered types requiring secrets', () => {
    expect(providerRequiresSecret('ollama')).toBe(false);
    expect(providerRequiresSecret('deepseek')).toBe(true);
    expect(providerRequiresSecret('coze')).toBe(true);
  });
});
