import { describe, expect, it } from 'vitest';
import { parseVersionPage, validateArtifactPrefix } from '@/lib/artifacts/version-store';
const prefix = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003';
const entry = (key: string, version = 'v-1') => '<Version><Key>' + key + '</Key><VersionId>' + version + '</VersionId></Version>';
const page = (body: string, suffix = '') => '<ListVersionsResult>' + body + '<IsTruncated>false</IsTruncated>' + suffix + '</ListVersionsResult>';
describe('exact artifact version enumeration', () => {
  it('accepts exact versions and delete markers only within a declared part key', () => {
    const key = prefix + '/parts/00001';
    const result = parseVersionPage(page(entry(key) + '<DeleteMarker><Key>' + key + '</Key><VersionId>marker-1</VersionId></DeleteMarker>'), prefix, 1);
    expect(result.versions).toEqual([{ key, versionId: 'v-1', deleteMarker: false }, { key, versionId: 'marker-1', deleteMarker: true }]);
  });
  it('decodes keys even when the encoding element follows the entries', () => {
    const key = prefix + '/parts/00001';
    expect(parseVersionPage(page(entry(encodeURIComponent(key)), '<EncodingType>url</EncodingType>'), prefix, 1).versions[0].key).toBe(key);
  });
  it.each([prefix + '/parts/00002', prefix + '/parts/00000', prefix + '/parts/../else', 'else/parts/00001', prefix + 'x/parts/00001'])('rejects out-of-scope keys: %s', key => {
    expect(() => parseVersionPage(page(entry(key)), prefix, 1)).toThrow('SCOPE_INVALID');
  });
  it('rejects null versions, invalid XML, DTD and truncated responses without cursors', () => {
    expect(() => parseVersionPage(page(entry(prefix + '/parts/00001', 'null')), prefix, 1)).toThrow();
    expect(() => parseVersionPage('<ListVersionsResult>', prefix, 1)).toThrow();
    expect(() => parseVersionPage('<!DOCTYPE x><ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>', prefix, 1)).toThrow();
    expect(() => parseVersionPage('<ListVersionsResult><IsTruncated>true</IsTruncated></ListVersionsResult>', prefix, 1)).toThrow('CURSOR_MISSING');
    expect(() => validateArtifactPrefix('')).toThrow();
  });
});
