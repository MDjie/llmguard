import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { S3ArchiveObjectStore } from '../../src/lib/conversation-archive/object-store';
import type { S3Presigner } from '../../src/lib/object-store';
const key = 'archives/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/' + 'a'.repeat(64) + '.json';
const bytes = new TextEncoder().encode('encrypted-fixture'), digest = createHash('sha256').update(bytes).digest('hex');
const presign = vi.fn<Pick<S3Presigner, 'presign'>['presign']>(async (method, _key, options) => ({ url: 'https://archive.invalid/object?version=' + (options?.versionId ?? ''), headers: { ...(options?.ifNoneMatch ? { 'if-none-match': '*' } : {}), method } }));
describe('versioned immutable archive objects', () => {
  it('verifies the uploaded version before returning persistence confirmation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'x-amz-version-id': 'v1' } })).mockResolvedValueOnce(new Response(bytes, { headers: { 'x-amz-version-id': 'v1' } }));
    const saved = await new S3ArchiveObjectStore({ presign }, fetcher).putImmutable(key, bytes);
    expect(saved).toEqual({ objectVersion: 'v1', ciphertextSha256: digest, sizeBytes: bytes.length });
    expect(fetcher.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ 'if-none-match': '*' }));
    expect(String(fetcher.mock.calls[1][0])).toContain('version=v1');
  });
  it('recovers an acknowledged-lost upload only if existing bytes and version match', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 412 })).mockResolvedValueOnce(new Response(bytes, { headers: { 'x-amz-version-id': 'v2' } }));
    expect((await new S3ArchiveObjectStore({ presign }, fetcher).putImmutable(key, bytes)).objectVersion).toBe('v2');
    const wrong = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 412 })).mockResolvedValueOnce(new Response('wrong', { headers: { 'x-amz-version-id': 'v2' } }));
    await expect(new S3ArchiveObjectStore({ presign }, wrong).putImmutable(key, bytes)).rejects.toThrow('DIGEST_MISMATCH');
  });
  it('rejects unversioned storage, unexpected versions, missing bytes and redirects', async () => {
    await expect(new S3ArchiveObjectStore({ presign }, vi.fn<typeof fetch>().mockResolvedValue(new Response(null))).putImmutable(key, bytes)).rejects.toThrow('VERSIONING_REQUIRED');
    const wrongVersion = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, { headers: { 'x-amz-version-id': 'v2' } }));
    await expect(new S3ArchiveObjectStore({ presign }, wrongVersion).readVersion(key, { objectVersion: 'v1', ciphertextSha256: digest, sizeBytes: bytes.length })).rejects.toThrow('VERSION_MISMATCH');
    expect(wrongVersion.mock.calls[0][1]?.redirect).toBe('error');
    await expect(new S3ArchiveObjectStore({ presign }).readVersion('../escape', { objectVersion: 'v1', ciphertextSha256: digest, sizeBytes: bytes.length })).rejects.toThrow('KEY_INVALID');
  });
});
