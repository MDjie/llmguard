import { describe, expect, it } from 'vitest';
import { detectMagic, magicMatchesKind } from '../../src/lib/artifacts';

describe('artifact magic detection', () => {
  it.each([
    [Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg', 'IMAGE'],
    [Buffer.from('%PDF-1.7'), 'application/pdf', 'DOCUMENT'],
    [Buffer.from('ID3\u0004\u0000'), 'audio/mpeg', 'AUDIO'],
    [Buffer.from([0xff, 0xf1, 0x50, 0x80]), 'audio/aac', 'AUDIO'],
    [Buffer.from('RIFFxxxxWAVE'), 'audio/wav', 'AUDIO'],
    [Buffer.from('xxxxftypisom'), 'video/mp4', 'VIDEO'],
  ])('recognizes %s as %s', (bytes, mediaType, kind) => {
    const detected = detectMagic(bytes);
    expect(detected.mediaType).toBe(mediaType);
    expect(magicMatchesKind(kind, detected)).toBe(true);
  });

  it('does not accept executable-like binary bytes as text', () => {
    expect(detectMagic(Buffer.from([0x4d, 0x5a, 0, 1])).family).toBe('unknown');
  });

  it('recognizes the ASF container used by WMA/WMV for governed disambiguation', () => {
    const bytes = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]);
    expect(detectMagic(bytes).mediaType).toBe('video/x-ms-wmv');
  });
});
