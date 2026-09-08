export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';
export interface DecodedText { readonly text: string; readonly encoding: TextEncoding; readonly bomBytes: number; }
/** Strict decoding. Legacy GB18030 must be explicitly selected, never guessed from malformed UTF-8. */
export function decodeText(bytes: Uint8Array, requested?: TextEncoding, prefix = false): DecodedText {
  let encoding: TextEncoding = requested ?? 'utf-8', bomBytes = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; bomBytes = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; bomBytes = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { encoding = 'utf-8'; bomBytes = 3; }
  if (requested && bomBytes && requested !== encoding) throw new Error('TEXT_ENCODING_BOM_MISMATCH');
  let text: string;
  try { text = new TextDecoder(encoding, {fatal: true}).decode(bytes.subarray(bomBytes), {stream: prefix}); }
  catch { throw new Error('TEXT_ENCODING_INVALID'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(text)) throw new Error('TEXT_BINARY_CONTENT');
  return {text, encoding, bomBytes};
}

/** Stateful strict validator: handles BOMs and multibyte sequences split across upload parts. */
export class StreamingTextValidator {
  private prefix = new Uint8Array(0);
  private decoder?: TextDecoder;
  constructor(private readonly requested?: TextEncoding) {}
  push(bytes: Uint8Array): void {
    if (!this.decoder) {
      const joined = new Uint8Array(this.prefix.length + bytes.length);
      joined.set(this.prefix); joined.set(bytes, this.prefix.length);
      if (joined.length < 4) { this.prefix = joined; return; }
      const detected = decodeText(joined.subarray(0, 4), this.requested, true);
      this.decoder = new TextDecoder(detected.encoding, {fatal:true});
      this.prefix = new Uint8Array(0);
      this.validate(this.decoder.decode(joined.subarray(detected.bomBytes), {stream:true}));
    } else this.validate(this.decoder.decode(bytes, {stream:true}));
  }
  finish(): void {
    if (!this.decoder) { decodeText(this.prefix, this.requested); return; }
    this.validate(this.decoder.decode());
  }
  private validate(text:string):void {
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(text)) throw new Error('TEXT_BINARY_CONTENT');
  }
}
export function textEncodingFromMetadata(metadata:Record<string,unknown>|null):TextEncoding|undefined {
  const value = metadata?.encoding;
  if (value === undefined) return undefined;
  if (value !== 'utf-8' && value !== 'utf-16le' && value !== 'utf-16be' && value !== 'gb18030') throw new Error('TEXT_ENCODING_UNSUPPORTED');
  return value;
}
