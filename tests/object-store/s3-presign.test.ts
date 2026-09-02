import { describe, expect, it } from 'vitest';
import { S3Presigner } from '../../src/lib/object-store';

describe('S3-compatible presigner', () => {
  it('produces deterministic scoped PUT signatures and signed hash metadata', async () => {
    const signer = new S3Presigner({
      endpoint: new URL('http://127.0.0.1:9000'),
      bucket: 'guard-artifacts',
      region: 'cn-test-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    }, { ...process.env, OBJECT_STORE_ALLOWED_PRIVATE_HOSTS: '127.0.0.1' });
    const options = {
      now: new Date('2026-01-02T03:04:05.000Z'),
      expiresSeconds: 300,
      sha256Header: 'a'.repeat(64),
    };
    const first = await signer.presign('PUT', 'tenant/app/parts/00001', options);
    const replay = await signer.presign('PUT', 'tenant/app/parts/00001', options);
    expect(first).toEqual(replay);
    expect(first.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(first.url).toContain('X-Amz-Signature=');
    expect(first.headers).toEqual({ 'x-amz-meta-sha256': 'a'.repeat(64) });
    expect(first.url).not.toContain('secret-key');
  });
});
