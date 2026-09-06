import { describe, expect, it } from 'vitest';
import {
  createApplicationApiKey,
  hashApplicationSecret,
} from '../../src/lib/tenancy/credentials';

const LEGACY_KEY = 'legacy-content-hash-key-longer-than-32-bytes';
const PEPPER = 'dedicated-credential-pepper-longer-than-32b';

describe('application credential pepper', () => {
  it('uses the dedicated CREDENTIAL_PEPPER when configured', () => {
    const hash = hashApplicationSecret('secret-1', {
      CONTENT_HASH_KEY: LEGACY_KEY,
      CREDENTIAL_PEPPER: PEPPER,
    } as unknown as NodeJS.ProcessEnv);
    const legacyHash = hashApplicationSecret('secret-1', {
      CONTENT_HASH_KEY: LEGACY_KEY,
    } as unknown as NodeJS.ProcessEnv);
    expect(hash).not.toBe(legacyHash);
  });

  it('falls back to CONTENT_HASH_KEY so existing credentials stay valid', () => {
    const withLegacyOnly = hashApplicationSecret('secret-1', {
      CONTENT_HASH_KEY: LEGACY_KEY,
    } as unknown as NodeJS.ProcessEnv);
    const withEmptyPepper = hashApplicationSecret('secret-1', {
      CONTENT_HASH_KEY: LEGACY_KEY,
      CREDENTIAL_PEPPER: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(withEmptyPepper).toBe(withLegacyOnly);
  });

  it('rejects when neither key is configured', () => {
    expect(() => hashApplicationSecret('secret-1', {} as unknown as NodeJS.ProcessEnv))
      .toThrow(/CREDENTIAL_PEPPER/);
  });

  it('issues API keys whose secret hash verifies', () => {
    const environment = {
      CONTENT_HASH_KEY: LEGACY_KEY,
      CREDENTIAL_PEPPER: PEPPER,
    } as unknown as NodeJS.ProcessEnv;
    const issued = createApplicationApiKey(environment);
    expect(issued.apiKey).toBe(`grd_${issued.keyId}.${issued.secret}`);
    expect(hashApplicationSecret(issued.secret, environment)).toBe(issued.secretHash);
  });
});
