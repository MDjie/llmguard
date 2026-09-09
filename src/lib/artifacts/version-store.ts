import { SaxesParser } from 'saxes';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
export interface ArtifactObjectVersion { key: string; versionId: string; deleteMarker: boolean }
export interface ArtifactVersionStore {
  list(prefix: string, partCount: number, signal?: AbortSignal): Promise<ArtifactObjectVersion[]>;
  remove(version: ArtifactObjectVersion, signal?: AbortSignal): Promise<void>;
}
export function validateArtifactPrefix(prefix: string): void {
  if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(prefix)) throw new Error('ARTIFACT_PURGE_PREFIX_INVALID');
}
export function parseVersionPage(xml: string, prefix: string, partCount: number) {
  validateArtifactPrefix(prefix);
  if (Buffer.byteLength(xml) > 2 * 1024 * 1024) throw new Error('ARTIFACT_VERSION_LIST_BUDGET');
  const rawVersions: ArtifactObjectVersion[] = [], path: string[] = [];
  let fields: Record<string, string> = {}, root = ''; const top: Record<string, string> = {};
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('ARTIFACT_VERSION_XML_INVALID'); });
  parser.on('opentag', tag => { path.push(tag.local); if (path.length === 1) root = tag.local; if (path.length === 2 && ['Version','DeleteMarker'].includes(tag.local)) fields = {}; });
  const append = (text: string) => {
    if (path.length === 2) top[path[1]] = (top[path[1]] ?? '') + text;
    if (path.length === 3 && ['Version','DeleteMarker'].includes(path[1])) fields[path[2]] = (fields[path[2]] ?? '') + text;
  };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', () => {
    if (path.length === 2 && ['Version','DeleteMarker'].includes(path[1])) {
      rawVersions.push({ key: fields.Key, versionId: fields.VersionId, deleteMarker: path[1] === 'DeleteMarker' });
    }
    path.pop();
  });
  parser.write(xml).close();
  if (root !== 'ListVersionsResult' || !['true','false'].includes(top.IsTruncated) || top.EncodingType && top.EncodingType !== 'url') throw new Error('ARTIFACT_VERSION_XML_INVALID');
  const versions = rawVersions.map(version => {
    const key = top.EncodingType === 'url' ? decodeURIComponent(version.key ?? '') : version.key;
    const suffix = key?.slice((prefix + '/parts/').length), number = Number(suffix);
    if (!key?.startsWith(prefix + '/parts/') || !/^\d{5}$/.test(suffix) || number < 1 || number > partCount || !version.versionId || version.versionId === 'null' || version.versionId.length > 1024) throw new Error('ARTIFACT_VERSION_SCOPE_INVALID');
    return { ...version, key };
  });
  const keyMarker = top.EncodingType === 'url' && top.NextKeyMarker ? decodeURIComponent(top.NextKeyMarker) : top.NextKeyMarker;
  if (top.IsTruncated === 'true' && (!keyMarker || !top.NextVersionIdMarker)) throw new Error('ARTIFACT_VERSION_CURSOR_MISSING');
  return { versions, truncated: top.IsTruncated === 'true', keyMarker, versionIdMarker: top.NextVersionIdMarker };
}
async function boundedText(response: Response) {
  if (!response.body) throw new Error('ARTIFACT_VERSION_LIST_EMPTY');
  const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 2 * 1024 * 1024) throw new Error('ARTIFACT_VERSION_LIST_BUDGET'); chunks.push(next.value); } }
  catch (error) { await reader.cancel().catch(() => undefined); throw error; } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export class S3ArtifactVersionStore implements ArtifactVersionStore {
  constructor(private readonly signer = new S3Presigner(objectStoreConfig()), private readonly fetchImpl: typeof fetch = fetch) {}
  async list(prefix: string, partCount: number, signal?: AbortSignal) {
    validateArtifactPrefix(prefix);
    const result: ArtifactObjectVersion[] = [], cursors = new Set<string>(); let keyMarker: string | undefined, versionIdMarker: string | undefined;
    for (let page = 0; page < 20; page++) {
      const signed = await this.signer.presign('GET', '', { expiresSeconds: 60, versions: { prefix: prefix + '/parts/', keyMarker, versionIdMarker } });
      const response = await this.fetchImpl(signed.url, { headers: signed.headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('ARTIFACT_VERSION_LIST_FAILED'); }
      const value = parseVersionPage(await boundedText(response), prefix, partCount); result.push(...value.versions);
      if (!value.truncated) return result;
      const cursor = JSON.stringify([value.keyMarker, value.versionIdMarker]); if (cursors.has(cursor)) throw new Error('ARTIFACT_VERSION_CURSOR_LOOP'); cursors.add(cursor);
      keyMarker = value.keyMarker; versionIdMarker = value.versionIdMarker;
    }
    throw new Error('ARTIFACT_VERSION_LIST_BUDGET');
  }
  async remove(version: ArtifactObjectVersion, signal?: AbortSignal) {
    const prefix = version.key.split('/').slice(0, 3).join('/'); validateArtifactPrefix(prefix);
    if (!version.key.startsWith(prefix + '/parts/') || !version.versionId || version.versionId === 'null') throw new Error('ARTIFACT_VERSION_SCOPE_INVALID');
    const signed = await this.signer.presign('DELETE', version.key, { expiresSeconds: 60, versionId: version.versionId });
    const response = await this.fetchImpl(signed.url, { method: 'DELETE', headers: signed.headers, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
    await response.body?.cancel(); if (!response.ok && response.status !== 404) throw new Error('ARTIFACT_VERSION_DELETE_FAILED');
  }
}
