import { describe, expect, it } from 'vitest';
import { resolvePolicyReleaseAssurance } from '../../src/lib/policy-bundle/readiness';

describe('policy release assurance', () => {
  it('accepts local bootstrap evidence only in development deployments', () => {
    expect(resolvePolicyReleaseAssurance('bootstrap_activate', 'local-compose')).toEqual({
      level: 'operator-attested-development-only',
      externalApproval: false,
    });
    expect(() => resolvePolicyReleaseAssurance('bootstrap_activate', 'production'))
      .toThrow(/not permitted/);
  });

  it('requires a recognized production activation transition', () => {
    expect(resolvePolicyReleaseAssurance('activate', 'production')).toEqual({
      level: 'production-approved',
      externalApproval: true,
    });
    expect(resolvePolicyReleaseAssurance('rollback_restore', 'production')).toEqual({
      level: 'production-approved',
      externalApproval: true,
    });
    expect(() => resolvePolicyReleaseAssurance(undefined, 'production')).toThrow(/evidence/);
  });
});
