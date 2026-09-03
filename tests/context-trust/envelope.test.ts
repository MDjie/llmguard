import { describe, expect, it } from 'vitest';
import type { ContextEnvelope, GuardRequest, Observation } from '@guardllm/contracts';
import {
  ActionIntentError,
  attachContextSources,
  ContextEnvelopeError,
  contextContentHash,
  resolveContextEnvelopes,
  validateActionIntent,
} from '../../src/lib/context-trust';

function request(
  text: string,
  envelopes?: readonly ContextEnvelope[],
  sessionId = 'session-1',
): GuardRequest {
  return {
    contractVersion: '1.0',
    context: {
      traceId: 'trace-0000000000000001',
      requestId: 'request-00000001',
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      sessionId,
      direction: 'INPUT',
      absoluteDeadlineEpochMs: Date.now() + 2_000,
      policyBundleId: 'bundle-1',
    },
    content: envelopes === undefined ? { text } : { text, envelopes },
  };
}

function envelope(
  text: string,
  start: number,
  end: number,
  eventSeq: number,
  overrides: Partial<ContextEnvelope> = {},
): ContextEnvelope {
  return {
    envelopeId: `env-${eventSeq}`,
    tenantId: 'tenant-1',
    applicationId: 'app-1',
    sessionId: 'session-1',
    sourceType: 'USER',
    sourceId: `source-${eventSeq}`,
    trustLevel: 'UNTRUSTED',
    instructionCapability: 'ALLOWED',
    sensitivityLabels: [],
    contentHash: contextContentHash(text.slice(start, end)),
    parentEnvelopeIds: [],
    policyVersion: 'bundle-1',
    eventSeq,
    contentStart: start,
    contentEnd: end,
    ...overrides,
  };
}

function expectCode(
  operation: () => unknown,
  code: string,
  errorType: typeof ContextEnvelopeError | typeof ActionIntentError = ContextEnvelopeError,
): void {
  try {
    operation();
    throw new Error('Expected ContextEnvelopeError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(errorType);
    expect(error).toHaveProperty('code', code);
  }
}

describe('UWP-01 ContextEnvelope trust boundary', () => {
  it('creates a deterministic, tenant-bound compatibility envelope for legacy clients', () => {
    const candidate = request('ordinary input');
    const first = resolveContextEnvelopes(candidate);
    const replay = resolveContextEnvelopes(candidate);
    expect(replay).toEqual(first);
    expect(first).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-1',
        applicationId: 'app-1',
        sessionId: 'session-1',
        sourceType: 'USER',
        trustLevel: 'UNTRUSTED',
        instructionCapability: 'ALLOWED',
        contentStart: 0,
        contentEnd: 14,
      }),
    ]);
  });

  it('accepts an exact partition and binds evidence spanning both sources', () => {
    const text = 'trusted untrusted';
    const envelopes = [
      envelope(text, 0, 8, 0, {
        envelopeId: 'trusted',
        sourceType: 'SYSTEM',
        trustLevel: 'TRUSTED',
      }),
      envelope(text, 8, text.length, 1, {
        envelopeId: 'untrusted',
        sourceType: 'RAG',
        instructionCapability: 'DATA_ONLY',
      }),
    ];
    const resolved = resolveContextEnvelopes(request(text, envelopes));
    const observations: readonly Observation[] = [{
      detectorId: 'test',
      detectorVersion: '1',
      riskType: 'prompt_injection',
      score: 1,
      severity: 'CRITICAL',
      status: 'MATCH',
      reasonCode: 'TEST',
      evidence: [{
        viewId: 'original',
        start: 6,
        end: 10,
        contentHmac: '0'.repeat(64),
      }],
    }];
    expect(attachContextSources(observations, resolved)[0].evidence[0].sourceEnvelopeIds)
      .toEqual(['trusted', 'untrusted']);
  });

  it('rejects cross-scope, expired, tampered and capability-escalated envelopes', () => {
    const text = 'payload';
    const base = envelope(text, 0, text.length, 0);
    const cases: Array<[Partial<ContextEnvelope>, string]> = [
      [{ tenantId: 'tenant-2' }, 'GRD_CONTEXT_ENVELOPE_SCOPE_MISMATCH'],
      [{ expiresAtEpochMs: 99 }, 'GRD_CONTEXT_ENVELOPE_EXPIRED'],
      [{ contentHash: '0'.repeat(64) }, 'GRD_CONTEXT_ENVELOPE_HASH_MISMATCH'],
      [{
        sourceType: 'RAG',
        instructionCapability: 'ALLOWED',
      }, 'GRD_CONTEXT_ENVELOPE_CAPABILITY_ESCALATION'],
    ];
    for (const [override, code] of cases) {
      expectCode(
        () => resolveContextEnvelopes(request(text, [{ ...base, ...override }]), 100),
        code,
      );
    }
  });

  it('rejects duplicate identifiers, gaps and overlaps before detector execution', () => {
    const text = '0123456789';
    const duplicate = [
      envelope(text, 0, 5, 0, { envelopeId: 'same' }),
      envelope(text, 5, 10, 1, { envelopeId: 'same' }),
    ];
    expectCode(
      () => resolveContextEnvelopes(request(text, duplicate)),
      'GRD_CONTEXT_ENVELOPE_DUPLICATE',
    );

    const invalidPartitions = [
      [envelope(text, 0, 4, 0), envelope(text, 5, 10, 1)],
      [envelope(text, 0, 6, 0), envelope(text, 5, 10, 1)],
      [],
    ];
    for (const envelopes of invalidPartitions) {
      expectCode(
        () => resolveContextEnvelopes(request(text, envelopes)),
        'GRD_CONTEXT_ENVELOPE_COVERAGE_INVALID',
      );
    }
  });

  it('requires authenticated user or system authority for high-risk action intents', () => {
    const text = 'transfer funds';
    const source = envelope(text, 0, text.length, 0);
    const base = request(text, [source]);
    const withIntent: GuardRequest = {
      ...base,
      context: {
        ...base.context,
        subjectId: 'user-1',
        authContextId: 'mfa-1',
      },
      actionIntent: {
        intentId: 'intent-1',
        userGoal: 'transfer approved funds',
        toolName: 'payments.transfer',
        parametersDigest: 'a'.repeat(64),
        targetResource: 'account:destination',
        sideEffect: 'FINANCIAL',
        requiredPermissions: ['payments:write'],
        supportingEnvelopeIds: [source.envelopeId],
        dataDestinations: ['payments-service'],
        riskBudget: 0.1,
      },
    };
    expect(() => validateActionIntent(withIntent, [source])).not.toThrow();
    expectCode(
      () => validateActionIntent({
        ...withIntent,
        context: { ...withIntent.context, authContextId: undefined },
      }, [source]),
      'GRD_ACTION_INTENT_UNAUTHORIZED_SOURCE',
      ActionIntentError,
    );
    expectCode(
      () => validateActionIntent({
        ...withIntent,
        actionIntent: {
          ...withIntent.actionIntent!,
          supportingEnvelopeIds: ['unknown-envelope'],
        },
      }, [source]),
      'GRD_ACTION_INTENT_SOURCE_UNKNOWN',
      ActionIntentError,
    );
  });
});
