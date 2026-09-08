import { z } from 'zod';
import type { QuotaMetric, QuotaScopeType, QuotaWindow } from './quota-plan';
import type { ProviderType } from '@/lib/providers/registry';

export interface GuardQuotaLimit {
  readonly scopeType: QuotaScopeType;
  readonly metric: QuotaMetric;
  readonly window: QuotaWindow;
  readonly limit: number;
}

export interface GuardResourceAdmissionSpec {
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly tokenizerDigest: string;
  readonly tokenizerBaseUrl: string;
  readonly tokenizerPath: string;
  readonly tokenizerProviderType: ProviderType;
  readonly tokenizerTimeoutMs: number;
  readonly tokenizerMaximumRequestBytes: number;
  readonly tokenizerMaximumResponseBytes: number;
  readonly maximumInputTokens: number;
  readonly maximumRequestCostUnits?: number;
  readonly requestedOutputTokens: number;
  readonly sessionReserveTokens: number;
  readonly detectorCostUnits: number;
  readonly modelCostMultiplier: number;
  readonly concurrencyLeaseMs: number;
  readonly quotaLimits: readonly GuardQuotaLimit[];
}

const quotaLimitSchema = z.object({
  scopeType: z.enum([
    'TENANT', 'APPLICATION', 'SESSION', 'USER', 'USER_GROUP', 'CREDENTIAL', 'MODEL', 'API',
  ]),
  metric: z.enum([
    'REQUESTS', 'INPUT_TOKENS', 'OUTPUT_TOKENS', 'CONCURRENCY', 'COST_UNITS',
  ]),
  window: z.enum(['MINUTE', 'DAY', 'MONTH', 'INSTANT']),
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export function guardResourceAdmissionSpecSchema() {
  return z.object({
    modelId: z.string().min(1).max(256),
    tokenizerId: z.string().min(1).max(256),
    tokenizerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    tokenizerBaseUrl: z.url().max(2_048),
    tokenizerPath: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1024}$/),
    tokenizerProviderType: z.enum([
      'openai_compatible', 'deepseek', 'kimi', 'doubao', 'qwen', 'glm', 'ollama', 'custom',
    ]),
    tokenizerTimeoutMs: z.number().int().min(50).max(30_000),
    tokenizerMaximumRequestBytes: z.number().int().min(1_024).max(4 * 1_024 * 1_024),
    tokenizerMaximumResponseBytes: z.number().int().min(512).max(64 * 1_024),
    maximumInputTokens: z.number().int().min(1).max(1_048_576),
    maximumRequestCostUnits: z.number().int().min(1).max(1_000_000_000).optional(),
    requestedOutputTokens: z.number().int().min(0).max(1_048_576),
    sessionReserveTokens: z.number().int().min(0).max(1_048_576),
    detectorCostUnits: z.number().int().min(0).max(100_000),
    modelCostMultiplier: z.number().finite().min(1).max(100),
    concurrencyLeaseMs: z.number().int().min(65_000).max(10 * 60_000),
    quotaLimits: z.array(quotaLimitSchema).min(1).max(512),
  }).strict().superRefine((value, context) => {
    const keys = value.quotaLimits.map((limit) =>
      [limit.scopeType, limit.metric, limit.window].join(':'));
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', message: 'Quota limits must be unique by scope, metric and window' });
    }
    for (const limit of value.quotaLimits) {
      const validWindow = limit.metric === 'CONCURRENCY'
        ? limit.window === 'INSTANT'
        : limit.window !== 'INSTANT';
      if (!validWindow) {
        context.addIssue({ code: 'custom', message: 'Quota metric and window combination is invalid' });
      }
    }
    const required = [
      ['CONCURRENCY', 'INSTANT'],
      ['REQUESTS', 'MINUTE'],
      ['INPUT_TOKENS', 'MINUTE'],
      ['OUTPUT_TOKENS', 'MINUTE'],
      ['COST_UNITS', 'DAY'],
      ['COST_UNITS', 'MONTH'],
    ] as const;
    const scopeTypes: readonly QuotaScopeType[] = [
      'TENANT', 'APPLICATION', 'USER', 'USER_GROUP', 'CREDENTIAL', 'MODEL', 'API',
      ...(value.quotaLimits.some((limit) => limit.scopeType === 'SESSION')
        ? ['SESSION' as const]
        : []),
    ];
    const configured = new Set(keys);
    for (const scopeType of scopeTypes) {
      for (const [metric, window] of required) {
        if (!configured.has([scopeType, metric, window].join(':'))) {
          context.addIssue({
            code: 'custom',
            message: 'Quota coverage is incomplete for ' + scopeType + ':' + metric + ':' + window,
          });
        }
      }
    }
  });
}

export function parseGuardResourceAdmissionBuildConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GuardResourceAdmissionSpec | undefined {
  const raw = environment.GUARD_RESOURCE_ADMISSION_CONFIG_JSON?.trim();
  if (!raw) return undefined;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('GUARD_RESOURCE_ADMISSION_CONFIG_JSON_INVALID');
  }
  return guardResourceAdmissionSpecSchema().parse(candidate);
}
