import { describe, expect, it } from 'vitest';
import {
  resourceMatches,
  signToolPermit,
  ToolPolicyError,
  validateToolParameters,
  verifyToolPermit,
} from '../../src/lib/tools';

describe('Tool/MCP policy enforcement', () => {
  it('matches only exact resources and explicit trailing-prefix patterns', () => {
    expect(resourceMatches(['/accounts/123', '/claims/*'], '/accounts/123')).toBe(true);
    expect(resourceMatches(['/accounts/123', '/claims/*'], '/claims/456')).toBe(true);
    expect(resourceMatches(['/accounts/123'], '/accounts/123/secrets')).toBe(false);
  });

  it('rejects unknown, missing, oversized and enum-invalid parameters', () => {
    const policy = {
      required: ['amount'], allowedKeys: ['amount', 'currency'], maxStringLength: 10,
      enums: { currency: ['CNY', 'USD'] },
    };
    expect(() => validateToolParameters(policy, { amount: 1, unexpected: true }))
      .toThrowError(ToolPolicyError);
    expect(() => validateToolParameters(policy, { currency: 'CNY' })).toThrowError(/required/);
    expect(() => validateToolParameters(policy, { amount: 1, currency: '01234567890' })).toThrowError(/bounded length/);
    expect(() => validateToolParameters(policy, { amount: 1, currency: 'EURO' })).toThrowError(/not approved/);
    expect(() => validateToolParameters(policy, { amount: 1, currency: 'CNY' })).not.toThrow();
  });

  it('binds permits to scope, tool, bundle, parameter hash and expiration', () => {
    const environment = { ...process.env, TOOL_PERMIT_KEY: 'tool-permit-test-key-32-bytes-minimum' };
    const permit = {
      version: 1 as const, invocationId: 'inv-1', tenantId: 'tenant-1', applicationId: 'app-1',
      toolId: 'tool-1', bundleId: 'bundle-1', parametersHash: 'a'.repeat(64), expiresAt: 2_000,
    };
    const token = signToolPermit(permit, environment);
    expect(verifyToolPermit(token, environment, 1_000)).toEqual(permit);
    expect(() => verifyToolPermit(token, environment, 2_001)).toThrowError(/expired/);
    expect(() => verifyToolPermit(`${token.slice(0, -1)}x`, environment, 1_000)).toThrowError(/signature/);
  });
});
