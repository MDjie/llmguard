import { describe, expect, it } from 'vitest';
import {
  PROVIDER_TYPES,
  providerChatRoute,
  providerDefaultBaseUrl,
  providerHosts,
  providerThinkingParameters,
  providerUpstreamErrorCodeAllowlist,
  providerUpstreamErrorMessages,
} from '../../src/lib/providers/registry';

describe('provider registry', () => {
  it('seeds the egress allowlist from vendor hosts', () => {
    expect(providerHosts('glm')).toEqual(['open.bigmodel.cn']);
    // DashScope serves a separate international endpoint.
    expect(providerHosts('qwen')).toEqual(['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com']);
    expect(providerHosts('custom')).toEqual([]);
    for (const type of PROVIDER_TYPES) expect(() => providerHosts(type)).not.toThrow();
  });

  it('keeps vendor default endpoints in sync with the catalog', () => {
    expect(providerDefaultBaseUrl('glm')).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(providerDefaultBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
    expect(providerDefaultBaseUrl('custom')).toBeUndefined();
  });

  it('routes bare hosts onto each vendor dialect', () => {
    expect(providerChatRoute('glm')).toBe('api/paas/v4/chat/completions');
    expect(providerChatRoute('doubao')).toBe('api/v3/chat/completions');
    expect(providerChatRoute('qwen')).toBe('compatible-mode/v1/chat/completions');
    expect(providerChatRoute('deepseek')).toBe('v1/chat/completions');
  });

  it('maps the thinking switch onto each vendor dialect', () => {
    expect(providerThinkingParameters('glm', 'disabled')).toEqual({ thinking: { type: 'disabled' } });
    expect(providerThinkingParameters('qwen', 'disabled')).toEqual({ enable_thinking: false });
    expect(providerThinkingParameters('ollama', 'disabled')).toEqual({ reasoning_effort: 'none' });
    expect(providerThinkingParameters('deepseek', 'enabled')).toEqual({});
    expect(providerThinkingParameters('openai_compatible', 'disabled')).toEqual({});
  });

  it('only propagates whitelisted upstream business codes', () => {
    expect(providerUpstreamErrorCodeAllowlist('glm')).toEqual(['1113', '1211', '1309']);
    expect(providerUpstreamErrorCodeAllowlist('deepseek')).toEqual([]);
    expect(providerUpstreamErrorMessages['1113']).toContain('余额不足');
    expect(providerUpstreamErrorMessages['9999']).toBeUndefined();
  });
});
