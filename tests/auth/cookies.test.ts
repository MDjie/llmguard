import { describe, expect, it } from 'vitest';
import { secureCookies } from '@/lib/auth/cookies';

describe('session cookie transport policy', () => {
  it('uses secure cookies by default in production', () => {
    expect(secureCookies({ NODE_ENV: 'production' })).toBe(true);
  });

  it('allows an explicit local HTTP deployment override', () => {
    expect(secureCookies({
      NODE_ENV: 'production',
      SESSION_COOKIE_SECURE: 'false',
    })).toBe(false);
  });

  it('allows secure cookies to be explicitly required outside production', () => {
    expect(secureCookies({
      NODE_ENV: 'development',
      SESSION_COOKIE_SECURE: 'true',
    })).toBe(true);
  });

  it('rejects ambiguous configuration values', () => {
    expect(() => secureCookies({
      NODE_ENV: 'production',
      SESSION_COOKIE_SECURE: 'yes',
    })).toThrow('must be either true or false');
  });
});
