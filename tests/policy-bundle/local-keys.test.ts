import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureLocalPolicySigningKeyPair,
  resolveLocalPolicyKeyPaths,
  validatePolicySigningKeyPair,
} from '../../src/lib/policy-bundle/local-keys';

const roots: string[] = [];

function workspace(): string {
  const root = path.join(tmpdir(), `guardllm-keygen-${process.pid}-${roots.length}`);
  mkdirSync(root, { recursive: false });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local policy signing key generation', () => {
  it('creates a separated pair once and returns only non-secret metadata', () => {
    const paths = resolveLocalPolicyKeyPaths(workspace());
    const created = ensureLocalPolicySigningKeyPair(paths);
    const reused = ensureLocalPolicySigningKeyPair(paths);

    expect(created.created).toBe(true);
    expect(reused.created).toBe(false);
    expect(created.publicKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reused.publicKeyFingerprint).toBe(created.publicKeyFingerprint);
    expect(Object.keys(created)).not.toContain('privateKey');
    expect(Object.keys(created)).not.toContain('privatePem');
  });

  it('refuses a partial pair instead of silently rotating it', () => {
    const paths = resolveLocalPolicyKeyPaths(workspace());
    mkdirSync(path.dirname(paths.privateKeyPath), { recursive: true });
    writeFileSync(paths.privateKeyPath, 'not-a-complete-pair');
    expect(() => ensureLocalPolicySigningKeyPair(paths)).toThrow(/Incomplete/);
  });

  it('rejects mismatched public and private keys', () => {
    const first = generateKeyPairSync('ed25519');
    const second = generateKeyPairSync('ed25519');
    const privatePem = first.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const wrongPublicPem = second.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => validatePolicySigningKeyPair(privatePem, wrongPublicPem)).toThrow(/do not match/);
  });
});
