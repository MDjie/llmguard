import type { ContextEnvelope, GuardRequest } from '@guardllm/contracts';

export type ActionIntentErrorCode =
  | 'GRD_ACTION_INTENT_EXPIRED'
  | 'GRD_ACTION_INTENT_INVALID'
  | 'GRD_ACTION_INTENT_SOURCE_UNKNOWN'
  | 'GRD_ACTION_INTENT_UNAUTHORIZED_SOURCE';

export class ActionIntentError extends Error {
  constructor(
    readonly code: ActionIntentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActionIntentError';
  }
}

const HIGH_RISK_SIDE_EFFECTS = new Set([
  'WRITE',
  'EXECUTE',
  'EXTERNAL_COMMUNICATION',
  'FINANCIAL',
  'PRIVILEGE_CHANGE',
]);

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function validateActionIntent(
  request: GuardRequest,
  envelopes: readonly ContextEnvelope[],
  now = Date.now(),
): void {
  const intent = request.actionIntent;
  if (intent === undefined) return;
  if (
    !/^[a-f0-9]{64}$/u.test(intent.parametersDigest) ||
    !Number.isFinite(intent.riskBudget) ||
    intent.riskBudget < 0 ||
    intent.riskBudget > 1 ||
    hasDuplicates(intent.requiredPermissions) ||
    hasDuplicates(intent.supportingEnvelopeIds) ||
    hasDuplicates(intent.dataDestinations)
  ) {
    throw new ActionIntentError(
      'GRD_ACTION_INTENT_INVALID',
      `Action intent ${intent.intentId} contains invalid or duplicate security metadata`,
    );
  }
  if (intent.expiresAtEpochMs !== undefined && intent.expiresAtEpochMs <= now) {
    throw new ActionIntentError(
      'GRD_ACTION_INTENT_EXPIRED',
      `Action intent ${intent.intentId} has expired`,
    );
  }
  const byId = new Map(envelopes.map((envelope) => [envelope.envelopeId, envelope]));
  const supporting = intent.supportingEnvelopeIds.map((envelopeId) => {
    const envelope = byId.get(envelopeId);
    if (envelope === undefined) {
      throw new ActionIntentError(
        'GRD_ACTION_INTENT_SOURCE_UNKNOWN',
        `Action intent ${intent.intentId} references unknown source ${envelopeId}`,
      );
    }
    return envelope;
  });
  if (HIGH_RISK_SIDE_EFFECTS.has(intent.sideEffect)) {
    const hasAuthenticatedAuthority =
      request.context.subjectId !== undefined &&
      request.context.authContextId !== undefined &&
      supporting.some((envelope) =>
        envelope.instructionCapability === 'ALLOWED' &&
        (envelope.sourceType === 'USER' || envelope.sourceType === 'SYSTEM'),
      );
    if (!hasAuthenticatedAuthority) {
      throw new ActionIntentError(
        'GRD_ACTION_INTENT_UNAUTHORIZED_SOURCE',
        `Action intent ${intent.intentId} lacks authenticated user or system authority`,
      );
    }
  }
}
