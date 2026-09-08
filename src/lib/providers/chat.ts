import { z } from 'zod';
import { safeFetchJson, type ProviderType } from '@/lib/egress';
import { getSecretProvider, type SecretProvider } from '@/lib/secrets';
import type { llmProviders } from '@/storage/database/shared/schema';
import { privateEndpointApproved } from '@/lib/judge/profile-registry';
import { readProviderDeployment } from './deployment';
import { providerAuthHeaderNameSchema, type ProviderAuthMode } from './deployment';

type ProviderRecord = typeof llmProviders.$inferSelect;
export type ProviderConnection = Pick<ProviderRecord, 'tenantId' | 'applicationId' | 'providerType' | 'baseUrl' | 'secretRef' | 'apiKeyEncrypted' | 'defaultModel'> & {
  readonly deploymentMode?: 'private' | 'cloud';
  readonly dataBoundaryPolicyId?: string;
  readonly configJson?: unknown;
};

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
    model: z.string().optional(),
    choices: z
      .array(z.object({ message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }).passthrough(), finish_reason: z.string().nullable().optional() }).passthrough())
      .optional(),
    message: z.object({ content: z.string().nullable() }).optional(),
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
  readonly temperature?: number | null;
  readonly path?: string;
  readonly authMode?: ProviderAuthMode;
  readonly authHeaderName?: string;
  readonly responseFormat?: 'json_object'|'json_schema';
  readonly responseSchema?: Record<string,unknown>;
  readonly thinkingMode?: 'enabled' | 'disabled';
  readonly reasoningEffort?: 'low' | 'high' | 'max';
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly secretProvider?: SecretProvider;
}

export interface ProviderChatResult {
  readonly id: string;
  readonly content: string;
  readonly reportedModel?: string;
  readonly finishReason?: string | null;
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

// Chat routes for vendors whose bare host serves no OpenAI-style /v1: Zhipu,
// Volcano Ark and DashScope only expose their own versioned paths.
const providerChatPaths: Readonly<Partial<Record<ProviderType, string>>> = {
  glm: 'api/paas/v4/chat/completions',
  doubao: 'api/v3/chat/completions',
  qwen: 'compatible-mode/v1/chat/completions',
};

// Tolerate endpoints pasted with the full chat route already appended; keep
// versioned bases as-is and give bare hosts the vendor's documented route.
function chatEndpoint(providerType: ProviderType, configured: string): { baseUrl: string; path: string } {
  const url = new URL(configured);
  const pathname = url.pathname.replace(/\/+$/, '');
  const pasted = pathname.endsWith('/chat/completions');
  const base = pasted ? pathname.slice(0, -'/chat/completions'.length) : pathname;
  const path = /\/v\d+$/u.test(base) || base.includes('/api/v') || base.includes('/compatible-mode/v1')
    ? 'chat/completions'
    : base === ''
      ? providerChatPaths[providerType] ?? 'v1/chat/completions'
      : 'v1/chat/completions';
  return { baseUrl: pasted ? `${url.origin}${base}` : configured, path };
}

// Thinking switches are vendor dialects: Zhipu and Volcano Ark use a typed
// object, DashScope a boolean, Ollama a reasoning effort; the other vendors have
// no switch (DeepSeek reasoner always thinks, OpenAI rejects unknown fields).
function thinkingParameters(providerType: ProviderType, mode: 'enabled' | 'disabled') {
  switch (providerType) {
    case 'glm': case 'doubao':
      return { thinking: { type: mode } };
    case 'qwen':
      return { enable_thinking: mode === 'enabled' };
    case 'ollama':
      return { reasoning_effort: mode === 'disabled' ? 'none' : 'medium' };
    default:
      return {};
  }
}

export async function resolveProviderSecret(
  provider: ProviderConnection,
  secretProvider?: SecretProvider,
  authMode?: ProviderAuthMode,
): Promise<string | undefined> {
  const providerType = parseProviderType(provider.providerType);
  if (authMode === 'none') {
    if (provider.deploymentMode !== 'private' || !provider.baseUrl || !provider.dataBoundaryPolicyId || !privateEndpointApproved({ ...provider, baseUrl: provider.baseUrl, dataBoundaryPolicyId: provider.dataBoundaryPolicyId })) throw new ProviderConfigurationError('PRIVATE_NO_AUTH_NOT_APPROVED', 'No-auth requires an approved private endpoint');
    return undefined;
  }
  if (providerType === 'ollama' && !authMode && !provider.secretRef) return undefined;
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

export function providerAuthHeaders(
  authMode: ProviderAuthMode | undefined,
  secret: string | undefined,
  authHeaderName?: string,
): Readonly<Record<string, string>> | undefined {
  if (authMode === 'none' || (!authMode && !secret)) return undefined;
  if (!secret) throw new ProviderConfigurationError('PROVIDER_SECRET_REQUIRED', 'Provider secret is not configured');
  if (authMode === 'api_key_header') {
    const parsedHeader = providerAuthHeaderNameSchema.safeParse(authHeaderName);
    if (!parsedHeader.success) throw new ProviderConfigurationError('PROVIDER_AUTH_HEADER_INVALID', 'Provider authentication header is invalid');
    return { [parsedHeader.data]: secret };
  }
  return { authorization: `Bearer ${secret}` };
}

export async function callProviderChat(
  provider: ProviderConnection,
  messages: readonly ProviderChatMessage[],
  options: ProviderChatOptions = {},
): Promise<ProviderChatResult> {
  const startedAt = Date.now();
  if(options.responseFormat==='json_schema'&&!options.responseSchema)throw new ProviderConfigurationError('PROVIDER_RESPONSE_SCHEMA_REQUIRED','JSON Schema mode requires a schema');
  const deployment = readProviderDeployment(provider.configJson);
  const providerType = parseProviderType(provider.providerType);
  const baseUrl = providerBaseUrl(providerType, provider.baseUrl);
  const connection = deployment ? {...provider, ...deployment, baseUrl} : provider;
  const apiKey = await resolveProviderSecret(connection, options.secretProvider, options.authMode ?? deployment?.authMode);
  const endpoint = chatEndpoint(providerType, baseUrl);
  const payload = await safeFetchJson({
    baseUrl: endpoint.baseUrl,
    path: options.path ?? endpoint.path,
    providerType,
    body: {
      model: options.model || provider.defaultModel,
      messages,
      ...(options.temperature === null ? {} : { temperature: options.temperature ?? 0.3 }),
      ...(options.responseFormat ? { response_format: options.responseFormat==='json_schema'
        ? {type:'json_schema',json_schema:{name:'guard_response',strict:true,schema:options.responseSchema}}
        : {type:options.responseFormat} } : {}),
      ...(options.thinkingMode ? thinkingParameters(providerType, options.thinkingMode) : {}),
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      max_tokens: options.maxTokens ?? 2_048,
      stream: false,
    },
    headers: providerAuthHeaders(options.authMode ?? deployment?.authMode, apiKey, options.authHeaderName ?? deployment?.authHeaderName),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const parsed = providerResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderConfigurationError('PROVIDER_RESPONSE_INVALID', 'Provider response schema is invalid');
  }
  const content = parsed.data.choices?.[0]?.message.content ?? parsed.data.message?.content;
  if (parsed.data.choices?.[0]?.message.refusal) throw new ProviderConfigurationError('PROVIDER_REFUSAL', 'Provider refused classification');
  if (!content) {
    throw new ProviderConfigurationError('PROVIDER_RESPONSE_EMPTY', 'Provider response content is empty');
  }

  const usage = parsed.data.usage;
  return {
    id: parsed.data.id ?? 'provider-response',
    content,
    reportedModel: parsed.data.model,
    finishReason: parsed.data.choices?.[0]?.finish_reason,
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
