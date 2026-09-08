// Single source of truth for supported model vendors. Adding a provider is a
// one-file change: extend PROVIDER_TYPES and add its descriptor below; the zod
// enums, egress host allowlist, default endpoints, chat routes, thinking
// dialects, connection probes and the /api/providers/meta catalog all derive
// from this module. This module must stay import-free to remain the leaf of
// the providers/egress dependency graph.

export const PROVIDER_TYPES = [
  'openai_compatible',
  'deepseek',
  'kimi',
  'doubao',
  'qwen',
  'glm',
  'ollama',
  'custom',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const providerThinkingControls = ['thinking_object', 'enable_thinking', 'reasoning_effort', 'none'] as const;
export type ProviderThinkingControl = (typeof providerThinkingControls)[number];

export interface ProviderDescriptor {
  readonly type: ProviderType;
  readonly label: string;
  /** Used when no base URL is configured. */
  readonly defaultBaseUrl?: string;
  /** Egress seed allowlist; deployments extend it through PROVIDER_ALLOWED_HOSTS. */
  readonly allowedHosts: readonly string[];
  /** Chat route for hosts configured without a versioned path; defaults to v1/chat/completions. */
  readonly chatPath?: string;
  readonly thinkingControl: ProviderThinkingControl;
  /** False only for vendors that serve unauthenticated local endpoints. */
  readonly requiresSecret: boolean;
  /** Suggested model ids surfaced by the management UI. */
  readonly suggestedModels: readonly string[];
  /** Recognized upstream business codes: the propagation allowlist and their operator-facing copy. */
  readonly errorCodes?: Readonly<Record<string, string>>;
}

const PROVIDERS: Readonly<Record<ProviderType, ProviderDescriptor>> = {
  openai_compatible: {
    type: 'openai_compatible',
    label: 'OpenAI Compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    allowedHosts: ['api.openai.com'],
    thinkingControl: 'none',
    requiresSecret: true,
    suggestedModels: ['gpt-4o-mini'],
  },
  deepseek: {
    type: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    allowedHosts: ['api.deepseek.com'],
    thinkingControl: 'none',
    requiresSecret: true,
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  kimi: {
    type: 'kimi',
    label: 'Kimi (月之暗面)',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    allowedHosts: ['api.moonshot.cn'],
    thinkingControl: 'none',
    requiresSecret: true,
    suggestedModels: ['moonshot-v1-8k'],
  },
  doubao: {
    type: 'doubao',
    label: '豆包 (字节跳动)',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    allowedHosts: ['ark.cn-beijing.volces.com'],
    chatPath: 'api/v3/chat/completions',
    thinkingControl: 'thinking_object',
    requiresSecret: true,
    suggestedModels: ['doubao-pro-4k'],
  },
  qwen: {
    type: 'qwen',
    label: '通义千问 (阿里)',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    allowedHosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
    chatPath: 'compatible-mode/v1/chat/completions',
    thinkingControl: 'enable_thinking',
    requiresSecret: true,
    suggestedModels: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
  },
  glm: {
    type: 'glm',
    label: 'GLM (智谱)',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    allowedHosts: ['open.bigmodel.cn'],
    chatPath: 'api/paas/v4/chat/completions',
    thinkingControl: 'thinking_object',
    requiresSecret: true,
    suggestedModels: ['glm-5.3', 'glm-5.3-flash'],
    errorCodes: {
      '1113': '智谱当前端点返回余额不足（1113）。请核对套餐专属 Base URL、密钥归属及当前模型权限；这不代表企业套餐总额度已耗尽。',
      '1211': '智谱模型标识无效或不可用（1211）。请填写账户实际支持的模型 ID。',
      '1309': '智谱套餐已过期（1309）。请核对套餐有效期。',
    },
  },
  ollama: {
    type: 'ollama',
    label: 'Ollama (本地)',
    defaultBaseUrl: 'http://localhost:11434/v1',
    allowedHosts: [],
    thinkingControl: 'reasoning_effort',
    requiresSecret: false,
    suggestedModels: ['llama2'],
  },
  custom: {
    type: 'custom',
    label: '自定义 OpenAI 兼容端点',
    allowedHosts: [],
    thinkingControl: 'none',
    requiresSecret: true,
    suggestedModels: [],
  },
};

export function providerDescriptor(type: string): ProviderDescriptor | undefined {
  return (PROVIDERS as Readonly<Record<string, ProviderDescriptor | undefined>>)[type];
}

/** Unknown types fail closed: callers treat them as secret-requiring. */
export function providerRequiresSecret(type: string): boolean {
  return providerDescriptor(type)?.requiresSecret ?? true;
}

export function providerDefaultBaseUrl(type: ProviderType): string | undefined {
  return PROVIDERS[type].defaultBaseUrl;
}

export function providerChatRoute(type: ProviderType): string {
  return PROVIDERS[type].chatPath ?? 'v1/chat/completions';
}

export function providerHosts(type: ProviderType): readonly string[] {
  return PROVIDERS[type].allowedHosts;
}

export function providerUpstreamErrorCodeAllowlist(type: ProviderType): readonly string[] {
  return Object.keys(PROVIDERS[type].errorCodes ?? {});
}

export function providerThinkingParameters(
  type: ProviderType,
  mode: 'enabled' | 'disabled',
): Record<string, unknown> {
  switch (PROVIDERS[type].thinkingControl) {
    case 'thinking_object':
      return { thinking: { type: mode } };
    case 'enable_thinking':
      return { enable_thinking: mode === 'enabled' };
    case 'reasoning_effort':
      return { reasoning_effort: mode === 'disabled' ? 'none' : 'medium' };
    default:
      return {};
  }
}

export const providerUpstreamErrorMessages: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(PROVIDER_TYPES.flatMap((type) => Object.entries(PROVIDERS[type].errorCodes ?? {}))),
);
