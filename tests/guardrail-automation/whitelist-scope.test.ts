import { describe, expect, it } from 'vitest';
import { whitelistSuppressesRuleMatch } from '../../src/lib/detection/whitelist-match';
import type { WhitelistRule } from '../../src/lib/detection/types';

const now = Date.parse('2026-09-06T00:00:00.000Z');
const approved: WhitelistRule = { id: 'white-1', name: 'quoted training phrase', policyScope: 'specific', policyIds: ['policy-a'], dimensionScope: 'specific', dimensionCodes: ['prompt_injection'], targetRuleIds: ['rule-a'], directions: ['INPUT'], validFromEpochMs: now - 1_000, expiresAtEpochMs: now + 1_000, approvalStatus: 'approved', approvedBy: 'reviewer-a', approvedAtEpochMs: now - 1_000, priority: 100, pattern: 'training: ignore me', matchType: 'contains', caseSensitive: false, enabled: true };
const call = (whitelist: WhitelistRule, text = 'training: ignore me', index = text.toLowerCase().indexOf('ignore me')) => whitelistSuppressesRuleMatch({ whitelist, text, match: { raw: text.slice(index, index + 'ignore me'.length), index }, ruleId: 'rule-a', dimensionCode: 'prompt_injection', direction: 'INPUT', now });

describe('scoped whitelist suppression', () => {
  it('suppresses only a target occurrence fully covered by an approved phrase', () => {
    expect(call(approved)).toBe(true);
    const text = 'training: ignore me; later ignore me';
    expect(call(approved, text, text.lastIndexOf('ignore me'))).toBe(false);
  });

  it.each([
    ['disabled', { enabled: false }],
    ['pending', { approvalStatus: 'pending' as const }],
    ['anonymous approval', { approvedBy: '' }],
    ['not active yet', { validFromEpochMs: now + 1 }],
    ['expired', { expiresAtEpochMs: now }],
    ['wrong dimension', { dimensionCodes: ['pii_leak'] }],
    ['wrong rule', { targetRuleIds: ['rule-b'] }],
    ['wrong direction', { directions: ['OUTPUT_COMPLETE' as const] }],
    ['global dimension', { dimensionScope: 'all' as const }],
  ])('rejects %s whitelist state', (_name, changes) => {
    expect(call({ ...approved, ...changes })).toBe(false);
  });

  it('honors exact, prefix, suffix and bounded regex matching without becoming a global bypass', () => {
    expect(call({ ...approved, pattern: 'ignore me', matchType: 'exact' }, 'ignore me', 0)).toBe(true);
    expect(call({ ...approved, pattern: 'ignore me training', matchType: 'prefix' }, 'ignore me training material', 0)).toBe(true);
    expect(call({ ...approved, pattern: 'training ignore me', matchType: 'suffix' }, 'approved training ignore me', 18)).toBe(true);
    expect(call({ ...approved, pattern: '^ignore me$', matchType: 'regex' }, 'ignore me', 0)).toBe(true);
    expect(call({ ...approved, pattern: 'ignore', matchType: 'prefix' }, 'ignore me', 0)).toBe(false);
  });
});
