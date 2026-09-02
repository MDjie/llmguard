import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret, type MasterKey } from '../../src/lib/secrets';

const key: MasterKey = { id: 'test-v1', bytes: Buffer.alloc(32, 7) };

describe('secret envelope', () => {
  it('encrypts and authenticates a provider secret', () => {
    const envelope = sealSecret('sk-test-not-a-real-key', 'sec_test', key);

    expect(envelope.ciphertext).not.toContain('sk-test');
    expect(openSecret(envelope, 'sec_test', key)).toBe('sk-test-not-a-real-key');
  });

  it('rejects tampering and reference substitution', () => {
    const envelope = sealSecret('sk-test-not-a-real-key', 'sec_test', key);

    expect(() => openSecret(envelope, 'sec_other', key)).toThrow();
    expect(() =>
      openSecret({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }, 'sec_test', key),
    ).toThrow();
  });
});
