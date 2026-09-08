import { decodeText } from '@/lib/media/formats/text-decoder';
export interface MagicDetection {
  readonly mediaType: string;
  readonly family: 'image' | 'audio' | 'video' | 'document' | 'text' | 'unknown';
  readonly container?: 'iso-bmff' | 'ebml' | 'asf' | 'zip' | 'ole';
}
const starts = (bytes: Uint8Array, signature: readonly number[]) => signature.every((value, index) => bytes[index] === value);
const ascii = (bytes: Uint8Array, offset: number, length: number) => new TextDecoder().decode(bytes.slice(offset, offset + length));
export function detectMagic(bytes: Uint8Array): MagicDetection {
  if (starts(bytes, [0xff, 0xd8, 0xff])) return {mediaType:'image/jpeg',family:'image'};
  if (starts(bytes, [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) return {mediaType:'image/png',family:'image'};
  if (/^GIF8[79]a$/.test(ascii(bytes,0,6))) return {mediaType:'image/gif',family:'image'};
  if (ascii(bytes,0,2)==='BM') return {mediaType:'image/bmp',family:'image'};
  if (starts(bytes,[0x49,0x49,0x2a,0]) || starts(bytes,[0x4d,0x4d,0,0x2a]) || starts(bytes,[0x49,0x49,0x2b,0]) || starts(bytes,[0x4d,0x4d,0,0x2b])) return {mediaType:'image/tiff',family:'image'};
  if (ascii(bytes,0,4)==='RIFF') {
    const kind=ascii(bytes,8,4);
    if (kind==='WEBP') return {mediaType:'image/webp',family:'image'};
    if (kind==='WAVE') return {mediaType:'audio/wav',family:'audio'};
    if (kind==='AVI ') return {mediaType:'video/x-msvideo',family:'video'};
  }
  if (ascii(bytes,0,4)==='%PDF') return {mediaType:'application/pdf',family:'document'};
  if (ascii(bytes,0,5).toLowerCase()==='{\\rtf') return {mediaType:'application/rtf',family:'document'};
  if (starts(bytes,[0x50,0x4b,3,4])) return {mediaType:'application/zip',family:'document',container:'zip'};
  if (starts(bytes,[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])) return {mediaType:'application/x-ole-storage',family:'document',container:'ole'};
  if (ascii(bytes,4,4)==='ftyp') {
    if(bytes.length<16) return {mediaType:'application/octet-stream',family:'unknown'};
    const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
    if(size<16||size%4!==0) return {mediaType:'application/octet-stream',family:'unknown'};
    const brands=[ascii(bytes,8,4)];
    for(let i=16;i+4<=Math.min(size,bytes.length,128);i+=4) brands.push(ascii(bytes,i,4));
    if(brands.some(b=>['avif','avis'].includes(b))) return {mediaType:'image/avif',family:'image',container:'iso-bmff'};
    if(brands.some(b=>['heic','heix','hevc','hevx','mif1','msf1'].includes(b))) return {mediaType:'image/heif',family:'image',container:'iso-bmff'};
    if(brands.some(b=>['M4A ','M4B '].includes(b))) return {mediaType:'audio/mp4',family:'audio',container:'iso-bmff'};
    if(brands.includes('qt  ')) return {mediaType:'video/quicktime',family:'video',container:'iso-bmff'};
    if(brands.some(b=>b.startsWith('3g'))) return {mediaType:'video/3gpp',family:'video',container:'iso-bmff'};
    return {mediaType:'video/mp4',family:'video',container:'iso-bmff'};
  }
  if(starts(bytes,[0x1a,0x45,0xdf,0xa3])) return {mediaType:ascii(bytes,0,Math.min(bytes.length,512)).includes('webm')?'video/webm':'video/x-matroska',family:'video',container:'ebml'};
  if(starts(bytes,[0x30,0x26,0xb2,0x75,0x8e,0x66,0xcf,0x11])) return {mediaType:'video/x-ms-wmv',family:'video',container:'asf'};
  if(ascii(bytes,0,4)==='OggS') return {mediaType:'audio/ogg',family:'audio'};
  if(ascii(bytes,0,4)==='fLaC') return {mediaType:'audio/flac',family:'audio'};
  if(ascii(bytes,0,5)==='#!AMR') return {mediaType:'audio/amr',family:'audio'};
  if(ascii(bytes,0,4)==='FORM'&&['AIFF','AIFC'].includes(ascii(bytes,8,4))) return {mediaType:'audio/aiff',family:'audio'};
  if(bytes[0]===0xff && [0xf1,0xf9].includes(bytes[1])) return {mediaType:'audio/aac',family:'audio'};
  if(ascii(bytes,0,3)==='ID3'||(bytes[0]===0xff && (bytes[1]&0xe0)===0xe0 && (bytes[1]&6)!==0)) return {mediaType:'audio/mpeg',family:'audio'};
  if(ascii(bytes,0,3)==='FLV') return {mediaType:'video/x-flv',family:'video'};
  if(starts(bytes,[0,0,1,0xba])||starts(bytes,[0,0,1,0xb3])) return {mediaType:'video/mpeg',family:'video'};
  if((bytes[0]===0x47&&bytes[188]===0x47&&bytes[376]===0x47)||(bytes[4]===0x47&&bytes[196]===0x47&&bytes[388]===0x47)) return {mediaType:'video/mp2t',family:'video'};
  try { if(bytes.length && decodeText(bytes,undefined,true).text.length) return {mediaType:'text/plain',family:'text'}; } catch { /* Unknown binary is never text. */ }
  return {mediaType:'application/octet-stream',family:'unknown'};
}
export function magicMatchesKind(kind: string, detected: MagicDetection): boolean {
  const expected=kind.toLowerCase();
  if(expected==='rag_chunk'||expected==='tool_result') return detected.family==='text'||detected.family==='document';
  // Actual stream kinds are checked by the isolated decoder before analysis can complete.
  if(expected==='audio' && ['ebml','asf','iso-bmff'].includes(detected.container??'') && detected.family==='video') return true;
  return detected.family===expected;
}
