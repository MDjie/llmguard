import { describe, expect, it } from 'vitest';
import { validateEvidenceLocation, segmentHighlightedText } from '../../src/lib/evidence/location';
const location = { artifactId: 'image', sourceDigest: 'a'.repeat(64), contentVersion: 'a'.repeat(64), contentPath: '/views/original', mappingVersion: 'guard-evidence-location-1', offsetEncoding: 'UTF16', textStart: 2, textEnd: 4, textLength: 4, region: [0, 0, 1, 1] };
describe('versioned evidence coordinates', () => {
  it('requires object identity and valid local coordinates', () => {
    expect(validateEvidenceLocation(location).state).toBe('VERIFIED');
    for (const invalid of [{ ...location, sourceDigest: undefined }, { ...location, textEnd: 5 }, { ...location, region: [0, 0, 2, 1] }, { ...location, startMs: 9, endMs: 3 }]) expect(validateEvidenceLocation(invalid)).toMatchObject({ state: 'UNVERIFIED', location: null });
  });
  it('splits overlapping UTF-16 ranges with all evidence identities and preserves HTML as text', () => {
    const text = '😀敏感词<script>';
    const result = segmentHighlightedText(text, [{ start: 2, end: 4, evidenceId: 'rule-a' }, { start: 3, end: 5, evidenceId: 'rule-b' }]);
    expect(result.map(part => part.text).join('')).toBe(text);
    expect(result.find(part => part.start === 3)?.evidenceIds).toEqual(['rule-a', 'rule-b']);
    expect(() => segmentHighlightedText(text, [{ start: 1, end: 4, evidenceId: 'invalid' }])).toThrow('RANGE_INVALID');
    expect(() => segmentHighlightedText('masked', [{ start: 2, end: 100, evidenceId: 'old-range' }])).toThrow('RANGE_INVALID');
  });
});
