import { describe, expect, it } from 'vitest';
import { updatePolicySchema } from '@/contracts/http/policies';

function payload(warn: unknown, block: unknown = '80.00') {
  return {
    policyId: 'policy-test',
    rules: [{ dimension: 'prompt_injection', warn_threshold: warn, block_threshold: block }],
  };
}

describe('policy threshold round-trip', () => {
  it('accepts database decimal strings and strips read-only rule fields', () => {
    const input = payload('50.00');
    const parsed = updatePolicySchema.parse({
      ...input,
      rules: [{ ...input.rules[0], tenant_id: 'untrusted', policy_id: 'other', created_at: '2026-09-05' }],
    });
    expect(parsed.rules?.[0]).toMatchObject({ warn_threshold: 50, block_threshold: 80 });
    expect(parsed.rules?.[0]).not.toHaveProperty('tenant_id');
    expect(parsed.rules?.[0]).not.toHaveProperty('policy_id');
    expect(parsed.rules?.[0]).not.toHaveProperty('created_at');
  });

  it.each([null, true, false, '', ' ', [], [50], {}, 'nope', 'Infinity', -1, 101, 50.5].map((value) => ({ value })))(
    'rejects invalid warning and blocking thresholds: $value', ({ value }) => {
      expect(updatePolicySchema.safeParse(payload(value)).success).toBe(false);
      expect(updatePolicySchema.safeParse(payload(0, value)).success).toBe(false);
    },
  );

  it('preserves numeric thresholds, defaults, and threshold ordering', () => {
    expect(updatePolicySchema.parse(payload(0, 100)).rules?.[0]).toMatchObject({
      warn_threshold: 0, block_threshold: 100,
    });
    expect(updatePolicySchema.parse(payload(undefined, undefined)).rules?.[0]).toMatchObject({
      warn_threshold: 50, block_threshold: 80,
    });
    expect(updatePolicySchema.safeParse(payload('90.00', '80.00')).success).toBe(false);
  });
});
