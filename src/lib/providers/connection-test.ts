import { EgressPolicyError, EgressRequestError } from '@/lib/egress';
import { ProviderConfigurationError, type ProviderChatOptions, type ProviderConnection } from './chat';

export interface ProviderTestFailure {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly upstreamStatus?: number;
  readonly upstreamCode?: string;
}

export function providerConnectionTestOptions(
  provider: Pick<ProviderConnection, 'providerType' | 'defaultModel'>,
): ProviderChatOptions {
  if (provider.providerType === 'glm' && /^glm-5\.3(?:$|-)/u.test(provider.defaultModel ?? '')) {
    return { maxTokens: 1_024, temperature: null, thinkingMode: 'enabled', reasoningEffort: 'low', timeoutMs: 30_000 };
  }
  return { maxTokens: 10, temperature: 0, timeoutMs: 10_000 };
}

const glmMessages: Readonly<Record<string, string>> = {
  '1113': '智谱当前端点返回余额不足（1113）。请核对套餐专属 Base URL、密钥归属及当前模型权限；这不代表企业套餐总额度已耗尽。',
  '1211': '智谱模型标识无效或不可用（1211）。请填写账户实际支持的模型 ID。',
  '1309': '智谱套餐已过期（1309）。请核对套餐有效期。',
};

const statusMessages: Readonly<Record<number, string>> = {
  401: '上游认证失败（HTTP 401），请核对 API Key。',
  403: '上游拒绝访问（HTTP 403），请核对账户和模型权限。',
  404: '上游接口不存在（HTTP 404），请核对 API Base URL 和模型服务地址。',
  429: '上游限流或额度不足（HTTP 429），请核对账户额度及并发限制。',
};

const codeMessages: Readonly<Record<string, string>> = {
  PROVIDER_SECRET_REQUIRED: '尚未配置 API Key。',
  LEGACY_SECRET_MIGRATION_REQUIRED: '旧版模型密钥需要迁移后才能使用。',
  REQUEST_ABORTED: '连接测试已取消或超时，请稍后重试。',
  NETWORK_FAILED: '无法连接模型服务，请核对地址和网络。',
  PROVIDER_RESPONSE_EMPTY: '模型未返回正文，可能耗尽输出额度，请核对模型的推理和输出参数。',
  PROVIDER_RESPONSE_INVALID: '模型响应格式不兼容，请使用 Chat Completions 接口。',
};

export function providerTestFailure(error: unknown): ProviderTestFailure {
  const errorCode = error instanceof EgressPolicyError
    || error instanceof EgressRequestError
    || error instanceof ProviderConfigurationError
    ? error.code
    : 'PROVIDER_TEST_FAILED';
  const upstreamStatus = error instanceof EgressRequestError ? error.status : undefined;
  const upstreamCode = error instanceof EgressRequestError ? error.upstreamCode : undefined;
  return {
    errorCode,
    errorMessage: (upstreamCode ? glmMessages[upstreamCode] : undefined)
      ?? (upstreamStatus ? statusMessages[upstreamStatus] : undefined)
      ?? codeMessages[errorCode]
      ?? '模型连接测试失败，请根据错误码检查服务配置。',
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
  };
}
