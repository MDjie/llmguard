import { describe, expect, it } from 'vitest';
import { resolveDatabaseTls } from '@/storage/database/shared/tls';

describe('DAT-002 verified database transport', () => {
  it('allows plaintext only for loopback development by default', () => {
    expect(resolveDatabaseTls('postgres://user:password@127.0.0.1:5432/db')).toBe(false);
  });

  it('requires certificate verification for remote databases', () => {
    expect(resolveDatabaseTls('postgres://user:password@db.internal:5432/db')).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('normalizes an enterprise CA without disabling verification', () => {
    expect(resolveDatabaseTls('postgres://user:password@db.internal:5432/db', {
      sslMode: 'verify-full',
      caCertificate: '-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----',
    })).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
    });
  });

  it.each(['allow', 'prefer', 'no-verify', 'verify-none'])(
    'rejects insecure TLS mode %s',
    (sslMode) => {
      expect(() => resolveDatabaseTls('postgres://user:password@db.internal:5432/db', {
        sslMode,
      })).toThrow('verify the server certificate');
    },
  );

  it('rejects disabling TLS for a remote production database', () => {
    expect(() => resolveDatabaseTls('postgres://user:password@db.internal:5432/db', {
      sslMode: 'disable',
      nodeEnv: 'production',
    })).toThrow('must use verified TLS');
  });
});
