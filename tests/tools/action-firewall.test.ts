import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@guardllm/contracts';
import { evaluateActionIntent } from '../../src/lib/tools';

const intent: ActionIntent = {
  intentId: 'intent-1',
  userGoal: 'Send the approved claim status to the customer',
  toolName: 'claims-notifier',
  parametersDigest: 'a'.repeat(64),
  targetResource: '/claims/123',
  sideEffect: 'EXTERNAL_COMMUNICATION',
  requiredPermissions: ['claim:notify'],
  supportingEnvelopeIds: ['user-confirmation-1'],
  dataDestinations: ['https://notify.example/customer/123'],
  riskBudget: 100,
  expiresAtEpochMs: 2_000,
};

const base = {
  intent,
  now: 1_000,
  parametersDigest: 'a'.repeat(64),
  principalPermissions: ['claim:notify'],
  tool: {
    name: 'claims-notifier',
    sideEffect: 'EXTERNAL_COMMUNICATION' as const,
    requiredPermissions: ['claim:notify'],
    allowedDataDestinations: ['https://notify.example/*'],
    highRisk: true,
    approvalRequired: false,
  },
  action: 'send',
  resource: '/claims/123',
  contextTainted: false,
};

describe('Action Firewall', () => {
  it('routes high-risk, evidenced actions to approval', () => {
    expect(evaluateActionIntent(base)).toMatchObject({
      disposition: 'REQUIRE_APPROVAL',
      riskCost: 35,
      attributionStatus: 'PENDING_APPROVAL',
    });
  });

  it('blocks parameter substitution, expired intents and missing evidence', () => {
    expect(evaluateActionIntent({ ...base, parametersDigest: 'b'.repeat(64) }).reasonCodes)
      .toContain('ACTION_INTENT_PARAMETERS_MISMATCH');
    expect(evaluateActionIntent({ ...base, now: 2_001 }).reasonCodes)
      .toContain('ACTION_INTENT_EXPIRED');
    expect(evaluateActionIntent({
      ...base,
      intent: { ...intent, supportingEnvelopeIds: [] },
    }).reasonCodes).toContain('ACTION_SUPPORTING_EVIDENCE_REQUIRED');
  });

  it('returns a machine-readable rewrite for unauthorized destinations', () => {
    const decision = evaluateActionIntent({
      ...base,
      intent: { ...intent, dataDestinations: ['https://attacker.invalid/exfiltrate'] },
    });
    expect(decision.disposition).toBe('REWRITE');
    expect(decision.repairSuggestion).toEqual({
      removeDataDestinations: ['https://attacker.invalid/exfiltrate'],
      allowedDataDestinations: ['https://notify.example/*'],
    });
  });

  it('fails closed for tainted high-risk context and exhausted action budget', () => {
    expect(evaluateActionIntent({ ...base, contextTainted: true }).reasonCodes)
      .toContain('ACTION_TAINTED_CONTEXT_DENIED');
    expect(evaluateActionIntent({
      ...base,
      intent: { ...intent, riskBudget: 20 },
    }).reasonCodes).toContain('ACTION_RISK_BUDGET_EXCEEDED');
  });
});
