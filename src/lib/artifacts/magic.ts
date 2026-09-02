export interface MagicDetection {
  readonly mediaType: string;
  readonly family: 'image' | 'audio' | 'video' | 'document' | 'text' | 'unknown';
}

const starts = (bytes: Uint8Array, signature: readonly number[]) =>
  signature.every((value, index) => bytes[index] === value);
const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  new TextDecoder().decode(bytes.slice(offset, offset + length));

export function detectMagic(bytes: Uint8Array): MagicDetection {
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { mediaType: 'image/jpeg', family: 'image' };
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mediaType: 'image/png', family: 'image' };
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return { mediaType: 'image/gif', family: 'image' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { mediaType: 'image/webp', family: 'image' };
  if (ascii(bytes, 0, 4) === '%PDF') return { mediaType: 'application/pdf', family: 'document' };
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return { mediaType: 'application/zip', family: 'document' };
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { mediaType: 'application/x-ole-storage', family: 'document' };
  if (bytes[0] === 0xff && (bytes[1] === 0xf1 || bytes[1] === 0xf9)) return { mediaType: 'audio/aac', family: 'audio' };
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { mediaType: 'audio/mpeg', family: 'audio' };
  if (ascii(bytes, 0, 4) === 'fLaC') return { mediaType: 'audio/flac', family: 'audio' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return { mediaType: 'audio/wav', family: 'audio' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'AVI ') return { mediaType: 'video/x-msvideo', family: 'video' };
  if (ascii(bytes, 4, 4) === 'ftyp') return { mediaType: 'video/mp4', family: 'video' };
  if (starts(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return { mediaType: 'video/x-ms-wmv', family: 'video' };
  const sample = ascii(bytes, 0, Math.min(bytes.length, 512));
  if (!sample.includes('\u0000')) return { mediaType: 'text/plain', family: 'text' };
  return { mediaType: 'application/octet-stream', family: 'unknown' };
}

export function magicMatchesKind(kind: string, detected: MagicDetection): boolean {
  const expected = kind.toLowerCase();
  if (expected === 'rag_chunk' || expected === 'tool_result') return detected.family === 'text' || detected.family === 'document';
  return detected.family === expected;
}
