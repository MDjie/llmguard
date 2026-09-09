import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  hasPermission,
  issueSession,
  nextLoginFailureState,
  normalizePlatformRole,
  permissionsForRole,
  passwordExpired,
  passwordMatchesHistory,
  passwordMaxAgeDays,
  validatePasswordPolicy,
  verifySessionToken,
  issueScopeSession,
  verifyScopeSession,
  verifyStoredPassword,
} from '../../src/lib/auth';

const testSecret = 'test-only-session-secret-at-least-32-bytes-long';

describe('authentication core', () => {
  it('enforces the strong password policy without logging password values', () => {
    const weak = validatePasswordPolicy('admin123', ['admin']);
    const strong = validatePasswordPolicy('Guard!Rail-29xZ', ['operator']);

    expect(weak.valid).toBe(false);
    expect(weak.violations).toContain('PASSWORD_TOO_SHORT');
    expect(weak.violations).toContain('PASSWORD_CONTAINS_IDENTITY');
    expect(strong).toEqual({ valid: true, violations: [] });
  });

  it('stores new passwords as bcrypt cost 12 and verifies them', async () => {
    const password = 'Guard!Rail-29xZ';
    const hash = await hashPassword(password);
    const result = await verifyStoredPassword(password, hash);

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain(password);
    expect(result).toEqual({ valid: true, legacyPlaintext: false, needsRehash: false });
  });

  it('UPG-IAM-001 expires local passwords after 90 days', () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    expect(passwordExpired(new Date('2026-06-05T00:00:01.000Z'), now)).toBe(false);
    expect(passwordExpired(new Date('2026-06-04T00:00:00.000Z'), now)).toBe(true);
    expect(passwordExpired(null, now)).toBe(true);
    expect(passwordMaxAgeDays({ PASSWORD_MAX_AGE_DAYS: '30' })).toBe(30);
    expect(() => passwordMaxAgeDays({ PASSWORD_MAX_AGE_DAYS: '0' })).toThrow(/between 1 and 365/);
  });

  it('UPG-IAM-001 rejects reuse of salted historical password hashes', async () => {
    const historical = await hashPassword('Previous!Guard-29xZ');
    expect(await passwordMatchesHistory('Previous!Guard-29xZ', [historical])).toBe(true);
    expect(await passwordMatchesHistory('Different!Guard-29xZ', [historical])).toBe(false);
  });

  it('recognizes a legacy plaintext password only for immediate migration', async () => {
    const result = await verifyStoredPassword('Legacy!Pass-29', 'Legacy!Pass-29');

    expect(result).toEqual({ valid: true, legacyPlaintext: true, needsRehash: true });
  });

  it('locks an account at the configured failure threshold', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const beforeThreshold = nextLoginFailureState(3, now);
    const threshold = nextLoginFailureState(4, now);

    expect(beforeThreshold).toEqual({ failedLoginCount: 4, lockedUntil: null });
    expect(threshold.failedLoginCount).toBe(5);
    expect(threshold.lockedUntil?.toISOString()).toBe('2026-09-01T00:15:00.000Z');
  });

  it('separates administration, security operations and independent audit', () => {
    expect(normalizePlatformRole('admin')).toBe('SYSTEM_ADMIN');
    expect(hasPermission('SYSTEM_ADMIN', 'iam:users:manage')).toBe(true);
    expect(hasPermission('SYSTEM_ADMIN', 'policy:read')).toBe(false);
    expect(hasPermission('SYSTEM_ADMIN', 'policy:manage')).toBe(false);
    expect(hasPermission('SYSTEM_ADMIN', 'security:operate')).toBe(false);
    expect(hasPermission('SYSTEM_ADMIN', 'audit:read')).toBe(false);
    expect(hasPermission('SECURITY_ADMIN', 'policy:manage')).toBe(true);
    expect(hasPermission('SECURITY_ADMIN', 'audit:read')).toBe(false);
    expect(hasPermission('AUDIT_ADMIN', 'audit:read')).toBe(true);
    expect(hasPermission('SYSTEM_ADMIN', 'data:catalog:manage')).toBe(false);
    expect(hasPermission('BUSINESS_OPERATOR', 'provider:read')).toBe(true);
    expect(hasPermission('APP_DEVELOPER', 'policy:read')).toBe(true);
    expect(hasPermission('SECURITY_ADMIN', 'data:catalog:manage')).toBe(true);
    expect(hasPermission('AUDIT_ADMIN', 'data:catalog:manage')).toBe(false);
    expect(hasPermission('READ_ONLY', 'data:catalog:read')).toBe(true);
  });

  it('limits a forced-password-change session to the password endpoint', () => {
    expect(permissionsForRole('SYSTEM_ADMIN', true)).toEqual(['auth:password:change']);
  });

  it('issues a versioned, audience-bound session token', () => {
    const issued = issueSession(
      { id: 'user-1', username: 'operator', role: 'BUSINESS_OPERATOR', tokenVersion: 7 },
      false,
      testSecret,
    );
    const claims = verifySessionToken(issued.token, testSecret);

    expect(claims.sub).toBe('user-1');
    expect(claims.tokenVersion).toBe(7);
    expect(claims.role).toBe('BUSINESS_OPERATOR');
    expect(issued.csrfToken.length).toBeGreaterThan(32);
  });

  it('signs tenant/application selection independently from the login token', () => {
    const issued = issueScopeSession(
      { id: 'user-1', tokenVersion: 7 },
      { tenantId: 'tenant-1', applicationId: 'application-2' },
      testSecret,
    );
    const claims = verifyScopeSession(issued.token, testSecret);
    expect(claims).toMatchObject({
      sub: 'user-1',
      tokenVersion: 7,
      tenantId: 'tenant-1',
      applicationId: 'application-2',
    });
    expect(() => verifySessionToken(issued.token, testSecret)).toThrow();
  });
});
