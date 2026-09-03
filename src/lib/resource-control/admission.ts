import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GuardRequest } from '@guardllm/contracts';
import type { AuthenticatedPrincipal } from '@/lib/api-security';
import { safeFetchJson, type SafeFetchDependencies } from '@/lib/egress';
import type { TenantScope } from '@/lib/tenancy';
import { buildQuotaClaims } from './quota-plan';
import { estimateGuardComplexity } from './complexity';
import type { GuardResourceAdmissionSpec } from './admission-config';
import {
  PostgresGuardQuotaStore,
  QuotaLimitExceededError,
  QuotaRequestReplayError,
  type GuardQuotaStore,
} from './quota-store';

const tokenizerResponseSchema = z.object({
  tokenizerId: z.string().min(1).max(256),
  tokenizerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  modelId: z.string().min(1).max(256),
  exact: z.literal(true),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  totalTokens: z.number().int().nonnegative().max(1_048_576),
}).strict();

type TokenizerResponse = z.infer<typeof tokenizerResponseSchema>;

export type ExactTokenizerInvoker = (
  spec: GuardResourceAdmissionSpec,
  text: string,
  signal: AbortSignal,
) => Promise<TokenizerResponse>;

export class GuardResourceAdmissionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GuardResourceAdmissionError';
  }
}

export interface GuardResourceAdmission {
  readonly inputTokens: number;
  readonly costUnits: number;
  readonly complexityScore: number;
  readonly reasonCodes: readonly string[];
  release(): Promise<void>;
}

async function invokeTokenizer(
  spec: GuardResourceAdmissionSpec,
  text: string,
  signal: AbortSignal,
  dependencies: SafeFetchDependencies,
): Promise<TokenizerResponse> {
  const result = await safeFetchJson({
    baseUrl: spec.tokenizerBaseUrl,
    path: spec.tokenizerPath,
    providerType: spec.tokenizerProviderType,
    timeoutMs: spec.tokenizerTimeoutMs,
    maxRequestBytes: spec.tokenizerMaximumRequestBytes,
    maxResponseBytes: spec.tokenizerMaximumResponseBytes,
    signal,
    body: {
      schemaVersion: '1.0',
      operation: 'count_exact_tokens',
      tokenizer: {
        id: spec.tokenizerId,
        digest: spec.tokenizerDigest,
        modelId: spec.modelId,
      },
      text,
    },
  }, dependencies);
  return tokenizerResponseSchema.parse(result);
}

function contentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function admitGuardRequest(input: {
  readonly spec: GuardResourceAdmissionSpec;
  readonly bundleId: string;
  readonly scope: TenantScope;
  readonly principal: AuthenticatedPrincipal;
  readonly request: GuardRequest;
  readonly quotaStore?: GuardQuotaStore;
  readonly tokenizerInvoker?: ExactTokenizerInvoker;
  readonly safeFetch?: SafeFetchDependencies;
}): Promise<GuardResourceAdmission> {
  if (
    input.request.context.tokenizerId &&
    input.request.context.tokenizerId !== input.spec.tokenizerId
  ) {
    throw new GuardResourceAdmissionError(
      'GUARD_TOKENIZER_REQUEST_MISMATCH',
      'The request tokenizer does not match the signed policy bundle',
    );
  }
  const text = input.request.content.text ?? '';
  const remaining = input.request.context.absoluteDeadlineEpochMs - Date.now();
  if (remaining <= 0) {
    throw new GuardResourceAdmissionError('GUARD_ADMISSION_DEADLINE_EXCEEDED', 'Admission deadline expired');
  }
  let measured: TokenizerResponse;
  try {
    const signal = AbortSignal.timeout(Math.min(remaining, input.spec.tokenizerTimeoutMs));
    measured = await (input.tokenizerInvoker
      ? input.tokenizerInvoker(input.spec, text, signal)
      : invokeTokenizer(input.spec, text, signal, input.safeFetch ?? {}));
  } catch {
    throw new GuardResourceAdmissionError(
      'GUARD_EXACT_TOKENIZER_UNAVAILABLE',
      'The exact tokenizer service did not return a verifiable result',
    );
  }
  if (
    measured.tokenizerId !== input.spec.tokenizerId ||
    measured.tokenizerDigest !== input.spec.tokenizerDigest ||
    measured.modelId !== input.spec.modelId ||
    measured.contentSha256 !== contentSha256(text)
  ) {
    throw new GuardResourceAdmissionError(
      'GUARD_EXACT_TOKENIZER_IDENTITY_MISMATCH',
      'Tokenizer identity or content binding did not match the signed policy bundle',
    );
  }
  if (measured.totalTokens > input.spec.maximumInputTokens) {
    throw new GuardResourceAdmissionError(
      'GUARD_INPUT_TOKEN_LIMIT_EXCEEDED',
      'The exact input token count exceeds the signed policy limit',
    );
  }
  const modalities = new Set(
    (input.request.content.artifacts ?? []).map((artifact) => artifact.kind),
  ).size;
  const complexity = estimateGuardComplexity({
    inputTokens: measured.totalTokens,
    requestedOutputTokens: input.spec.requestedOutputTokens,
    historicalTokens: input.spec.sessionReserveTokens,
    ragChunks: (input.request.content.envelopes ?? [])
      .filter((envelope) => envelope.sourceType === 'RAG').length,
    plannedToolCalls: input.request.actionIntent ? 1 : 0,
    modalities,
    detectorCostUnits: input.spec.detectorCostUnits,
    modelCostMultiplier: input.spec.modelCostMultiplier,
  });
  const claims = buildQuotaClaims({
    tenantId: input.scope.tenantId,
    applicationId: input.scope.applicationId,
    userId: input.principal.authenticationMethod === 'service'
      ? undefined
      : input.principal.subject,
    userGroupIds: input.principal.userGroupIds,
    credentialId: input.principal.authenticationMethod === 'service'
      ? input.principal.subject
      : undefined,
    modelId: input.spec.modelId,
    apiId: 'guard.v1.evaluate',
  }, {
    inputTokens: measured.totalTokens,
    outputTokens: input.spec.requestedOutputTokens,
    costUnits: complexity.costUnits,
  });
  const quotaStore = input.quotaStore ?? new PostgresGuardQuotaStore();
  let reservation;
  try {
    reservation = await quotaStore.reserve({
      scope: input.scope,
      policyBundleId: input.bundleId,
      requestId: input.request.context.requestId,
      claims,
      limits: input.spec.quotaLimits,
      concurrencyLeaseMs: input.spec.concurrencyLeaseMs,
    });
  } catch (error) {
    if (error instanceof QuotaLimitExceededError) {
      throw new GuardResourceAdmissionError(
        'GUARD_QUOTA_EXCEEDED',
        [
          error.claim.scopeType,
          error.claim.metric,
          error.claim.window,
          error.used,
          error.limit,
        ].join(':'),
      );
    }
    if (error instanceof QuotaRequestReplayError) {
      throw new GuardResourceAdmissionError(
        'GUARD_REQUEST_ID_REPLAYED',
        'The request ID has already consumed quota in this policy scope',
      );
    }
    throw error;
  }
  let released = false;
  return {
    inputTokens: measured.totalTokens,
    costUnits: complexity.costUnits,
    complexityScore: complexity.score,
    reasonCodes: complexity.reasonCodes,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await quotaStore.release(input.scope, reservation.releaseChargeIds);
    },
  };
}
