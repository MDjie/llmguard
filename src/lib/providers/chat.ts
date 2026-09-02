import { z } from 'zod';
import { safeFetchJson, type ProviderType } from '@/lib/egress';
import { getSecretProvider, type SecretProvider } from '@/lib/secrets';
import type { llmProviders } from '@/storage/database/shared/schema';

type ProviderRecord = typeof llmProviders.$inferSelect;

const providerTypes = new Set<ProviderType>([
  'openai_compatible',
  'deepseek',
  'kimi',
  'doubao',
  'qwen',
  'glm',
  'ollama',
  'custom',
]);

const defaultBaseUrls: Readonly<Partial<Record<ProviderType, string>>> = {
  openai_compatible: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  kimi: 'https://api.moonshot.cn/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  ollama: 'http://localhost:11434/v1',
};

const providerResponseSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(z.object({ message: z.object({ content: z.string() }) }).passthrough())
      .optional(),
    message: z.object({ content: z.string() }).optional(),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();

export interface ProviderChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ProviderChatOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly secretProvider?: SecretProvider;
}

export interface ProviderChatResult {
  readonly id: string;
  readonly content: string;
  readonly latencyMs: number;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export class ProviderConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

export function parseProviderType(value: string): ProviderType {
  if (!providerTypes.has(value as ProviderType)) {
    throw new ProviderConfigurationError('PROVIDER_TYPE_UNSUPPORTED', 'Provider type is unsupported');
  }
  return value as ProviderType;
}

export function providerBaseUrl(providerType: ProviderType, configured: string | null): string {
  const value = configured?.trim() || defaultBaseUrls[providerType];
  if (!value) {
    throw new ProviderConfigurationError('PROVIDER_BASE_URL_REQUIRED', 'Provider base URL is required');
  }
  return value;
}

function chatPath(baseUrl: string): string {
  const pathname = new URL(baseUrl).pathname.replace(/\/$/, '');
  return pathname.endsWith('/v1') || pathname.includes('/api/v') || pathname.includes('/compatible-mode/v1')
    ? 'chat/completions'
    : 'v1/chat/completions';
}

export async function resolveProviderSecret(
  provider: ProviderRecord,
  secretProvider?: SecretProvider,
): Promise<string | undefined> {
  const providerType = parseProviderType(provider.providerType);
  if (providerType === 'ollama') return undefined;
  if (provider.secretRef) {
    const scopedSecretProvider = secretProvider ?? getSecretProvider({
      tenantId: provider.tenantId,
      applicationId: provider.applicationId,
    });
    return scopedSecretProvider.get(provider.secretRef);
  }
  if (provider.apiKeyEncrypted) {
    throw new ProviderConfigurationError(
      'LEGACY_SECRET_MIGRATION_REQUIRED',
      'Provider secret must be migrated before use',
    );
  }
  throw new ProviderConfigurationError('PROVIDER_SECRET_REQUIRED', 'Provider secret is not configured');
}

export async function callProviderChat(
  provider: ProviderRecord,
  messages: readonly ProviderChatMessage[],
  options: ProviderChatOptions = {},
): Promise<ProviderChatResult> {
  const startedAt = Date.now();
  const providerType = parseProviderType(provider.providerType);
  const baseUrl = providerBaseUrl(providerType, provider.baseUrl);
  const apiKey = await resolveProviderSecret(provider, options.secretProvider);
  const payload = await safeFetchJson({
    baseUrl,
    path: chatPath(baseUrl),
    providerType,
    body: {
      model: options.model || provider.defaultModel,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2_048,
      stream: false,
    },
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const parsed = providerResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderConfigurationError('PROVIDER_RESPONSE_INVALID', 'Provider response schema is invalid');
  }
  const content = parsed.data.choices?.[0]?.message.content ?? parsed.data.message?.content;
  if (!content) {
    throw new ProviderConfigurationError('PROVIDER_RESPONSE_EMPTY', 'Provider response content is empty');
  }

  const usage = parsed.data.usage;
  return {
    id: parsed.data.id ?? 'provider-response',
    content,
    latencyMs: Date.now() - startedAt,
    ...(usage
      ? {
          usage: {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
          },
        }
      : {}),
  };
}
