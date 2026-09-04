import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  policyPublicKeyFingerprint,
  policySigningKeyId,
  signingPrivateKey,
  verificationPublicKey,
} from '../../src/lib/policy-bundle';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = path.join(
    tmpdir(),
    `guardllm-policy-key-${process.pid}-${temporaryDirectories.length}`,
  );
  mkdirSync(directory, { recursive: false });
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('policy signing key material', () => {
  it('loads private and public PEM keys from separate files', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const directory = temporaryDirectory();
    const privatePath = path.join(directory, 'private.pem');
    const publicPath = path.join(directory, 'public.pem');
    writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));

    expect(signingPrivateKey({ POLICY_SIGNING_PRIVATE_KEY_FILE: privatePath }).type)
      .toBe('private');
    expect(verificationPublicKey({ POLICY_SIGNING_PUBLIC_KEY_FILE: publicPath }).type)
      .toBe('public');
    expect(policyPublicKeyFingerprint({ POLICY_SIGNING_PUBLIC_KEY_FILE: publicPath }))
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it('supports escaped inline PEM values without accepting ambiguous sources', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const inlinePrivate = privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString().replace(/\n/g, '\\n');
    const inlinePublic = publicKey.export({ type: 'spki', format: 'pem' })
      .toString().replace(/\n/g, '\\n');

    expect(signingPrivateKey({ POLICY_SIGNING_PRIVATE_KEY: inlinePrivate }).type)
      .toBe('private');
    expect(verificationPublicKey({ POLICY_SIGNING_PUBLIC_KEY: inlinePublic }).type)
      .toBe('public');
    expect(() => verificationPublicKey({
      POLICY_SIGNING_PUBLIC_KEY: inlinePublic,
      POLICY_SIGNING_PUBLIC_KEY_FILE: 'another-source.pem',
    })).toThrow(/exactly one/i);
  });

  it('requires an explicit bounded signing key id', () => {
    expect(policySigningKeyId({ POLICY_SIGNING_KEY_ID: 'local-ed25519-v1' }))
      .toBe('local-ed25519-v1');
    expect(() => policySigningKeyId({})).toThrow(/POLICY_SIGNING_KEY_ID/);
    expect(() => policySigningKeyId({ POLICY_SIGNING_KEY_ID: 'x'.repeat(129) }))
      .toThrow(/128/);
  });
});
