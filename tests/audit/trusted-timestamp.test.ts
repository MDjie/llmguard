import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  publicKeyFingerprint,
  requestTrustedTimestamp,
  trustedTimestampPayload,
  verifyTrustedTimestamp,
  type TrustedTimestampEnvelope,
} from '../../src/lib/audit/trusted-timestamp';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyFingerprint = publicKeyFingerprint(publicKeyPem);
const now = new Date('2026-09-02T03:00:00.000Z');

function signedEnvelope(
  digest: string,
  nonce: string,
): TrustedTimestampEnvelope {
  const unsigned = {
    version: '1.0' as const,
    provider: 'enterprise-tsa',
    digest,
    nonce,
    generatedAt: now.toISOString(),
    token: Buffer.from('opaque-enterprise-time-token').toString('base64'),
    keyFingerprint,
  };
  return {
    ...unsigned,
    signature: sign(
      'sha256',
      Buffer.from(trustedTimestampPayload(unsigned), 'utf8'),
      keys.privateKey,
    ).toString('base64'),
  };
}

describe('enterprise trusted timestamp adapter', () => {
  it('binds digest, nonce, time, token and key fingerprint to the provider signature', () => {
    const digest = createHash('sha256').update('audit-head').digest('hex');
    const envelope = signedEnvelope(digest, 'a'.repeat(32));
    expect(verifyTrustedTimestamp(envelope, {
      digest,
      nonce: 'a'.repeat(32),
      publicKeyPem,
      expectedKeyFingerprint: keyFingerprint,
      now,
    })).toBe(true);
    expect(verifyTrustedTimestamp({ ...envelope, digest: 'b'.repeat(64) }, {
      digest,
      nonce: 'a'.repeat(32),
      publicKeyPem,
      expectedKeyFingerprint: keyFingerprint,
      now,
    })).toBe(false);
  });

  it('validates a service response before returning it to the persistence worker', async () => {
    const digest = createHash('sha256').update('audit-head').digest('hex');
    const fetcher = async (_input: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { nonce: string };
      return Response.json(signedEnvelope(digest, request.nonce));
    };
    await expect(requestTrustedTimestamp(digest, {
      environment: {
        TRUSTED_TIMESTAMP_ENDPOINT: 'https://tsa.example.invalid/v1/timestamps',
        TRUSTED_TIMESTAMP_PUBLIC_KEY_PEM: publicKeyPem,
        TRUSTED_TIMESTAMP_KEY_FINGERPRINT: keyFingerprint,
      },
      fetcher: fetcher as typeof fetch,
      now,
    })).resolves.toMatchObject({ digest, provider: 'enterprise-tsa' });
  });
});
