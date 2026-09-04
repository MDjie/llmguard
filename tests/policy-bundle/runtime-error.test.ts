import { describe, expect, it } from 'vitest';
import {
  isTransientPolicyDatabaseError,
  policyLastKnownGoodMaxAgeMs,
} from '../../src/lib/policy-bundle/runtime-error';

describe('policy runtime failure classification', () => {
  it('limits last-known-good fallback to a bounded age', () => {
    expect(policyLastKnownGoodMaxAgeMs({})).toBe(300_000);
    expect(policyLastKnownGoodMaxAgeMs({ POLICY_LKG_MAX_AGE_MS: '1000' })).toBe(1_000);
    expect(() => policyLastKnownGoodMaxAgeMs({ POLICY_LKG_MAX_AGE_MS: '999' })).toThrow();
    expect(() => policyLastKnownGoodMaxAgeMs({ POLICY_LKG_MAX_AGE_MS: '86400001' })).toThrow();
  });

  it('only classifies transient database and transport failures as recoverable', () => {
    expect(isTransientPolicyDatabaseError({ code: '08006' })).toBe(true);
    expect(isTransientPolicyDatabaseError(new Error('outer', { cause: { code: 'ECONNREFUSED' } })))
      .toBe(true);
    expect(isTransientPolicyDatabaseError({ code: '23505' })).toBe(false);
    expect(isTransientPolicyDatabaseError(new Error('signature verification failed'))).toBe(false);
  });
});
