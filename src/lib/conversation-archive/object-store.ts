import { createHash } from 'node:crypto';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
const MAXIMUM_BYTES = 16 * 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface StoredArchiveObject { readonly objectVersion: string; readonly ciphertextSha256: string; readonly sizeBytes: number }
export interface ArchiveObjectStore {
  putImmutable(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<StoredArchiveObject>;
  readVersion(key: string, reference: StoredArchiveObject, signal?: AbortSignal): Promise<Uint8Array>;
  deleteVersion(key: string, version: string, signal?: AbortSignal): Promise<void>;
}
function validKey(key: string) {
  if (!/^archives\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9]{64}\.json$/.test(key)) throw new Error('ARCHIVE_OBJECT_KEY_INVALID');
}
function validVersion(value: string | null): string {
  if (!value || value === 'null' || value.length > 1024 || /[\r\n]/.test(value)) throw new Error('ARCHIVE_VERSIONING_REQUIRED'); return value;
}
async function boundedBytes(response: Response, limit = MAXIMUM_BYTES) {
  if (Number(response.headers.get('content-length')) > limit || !response.body) throw new Error('ARCHIVE_OBJECT_SIZE_INVALID');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) throw new Error('ARCHIVE_OBJECT_SIZE_INVALID'); chunks.push(chunk.value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export class S3ArchiveObjectStore implements ArchiveObjectStore {
  constructor(private readonly signer: Pick<S3Presigner, 'presign'>, private readonly fetchImpl: typeof fetch = fetch) {}
  private async request(method: 'GET' | 'PUT' | 'DELETE', key: string, options: Parameters<S3Presigner['presign']>[2], bytes?: Uint8Array, signal?: AbortSignal) {
    validKey(key); const signed = await this.signer.presign(method, key, { expiresSeconds: 60, ...options });
    return this.fetchImpl(signed.url, { method, headers: signed.headers, body: bytes ? new Uint8Array(bytes) : undefined, redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
  }
  async putImmutable(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<StoredArchiveObject> {
    if (!bytes.length || bytes.length > MAXIMUM_BYTES) throw new Error('ARCHIVE_OBJECT_SIZE_INVALID');
    const digest = sha256(bytes);
    const response = await this.request('PUT', key, { ifNoneMatch: true, checksumSha256: Buffer.from(digest, 'hex').toString('base64') }, bytes, signal);
    // A prior upload may have committed before the control plane saw the response.
    if (response.status !== 412 && !response.ok) { await response.body?.cancel(); throw new Error('ARCHIVE_OBJECT_WRITE_FAILED'); }
    const version = response.status === 412 ? undefined : validVersion(response.headers.get('x-amz-version-id'));
    await response.body?.cancel();
    const read = await this.request('GET', key, { versionId: version }, undefined, signal);
    if (!read.ok) { await read.body?.cancel(); throw new Error('ARCHIVE_OBJECT_VERIFY_FAILED'); }
    const objectVersion = validVersion(read.headers.get('x-amz-version-id'));
    if (version && version !== objectVersion) { await read.body?.cancel(); throw new Error('ARCHIVE_OBJECT_VERSION_MISMATCH'); }
    const observed = await boundedBytes(read, bytes.length);
    if (observed.length !== bytes.length || sha256(observed) !== digest) throw new Error('ARCHIVE_OBJECT_DIGEST_MISMATCH');
    return { objectVersion, ciphertextSha256: digest, sizeBytes: bytes.length };
  }
  async readVersion(key: string, reference: StoredArchiveObject, signal?: AbortSignal) {
    validVersion(reference.objectVersion);
    if (!Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 1 || reference.sizeBytes > MAXIMUM_BYTES) throw new Error('ARCHIVE_OBJECT_SIZE_INVALID');
    const response = await this.request('GET', key, { versionId: reference.objectVersion }, undefined, signal);
    if (!response.ok) { await response.body?.cancel(); throw new Error('ARCHIVE_OBJECT_READ_FAILED'); }
    if (validVersion(response.headers.get('x-amz-version-id')) !== reference.objectVersion) { await response.body?.cancel(); throw new Error('ARCHIVE_OBJECT_VERSION_MISMATCH'); }
    const bytes = await boundedBytes(response, reference.sizeBytes);
    if (bytes.length !== reference.sizeBytes || sha256(bytes) !== reference.ciphertextSha256) throw new Error('ARCHIVE_OBJECT_DIGEST_MISMATCH'); return bytes;
  }
  async deleteVersion(key: string, version: string, signal?: AbortSignal) {
    const response = await this.request('DELETE', key, { versionId: validVersion(version) }, undefined, signal);
    await response.body?.cancel(); if (!response.ok && response.status !== 404) throw new Error('ARCHIVE_OBJECT_DELETE_FAILED');
  }
}
export function archiveObjectStore() { return new S3ArchiveObjectStore(new S3Presigner(objectStoreConfig())); }
