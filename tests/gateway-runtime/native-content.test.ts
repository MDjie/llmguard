import type { JsonValue } from '@/lib/gateway-runtime/error';
import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {nativeMediaBlock,nativeMediaMetadata,NATIVE_MEDIA_MAX_BYTES} from '@/lib/gateway-runtime/native-content';
describe('native media inline wire representations',()=>{
 it('round-trips image, audio and video bytes without text conversion or URL identities',()=>{
  const bytes=Buffer.from([0,255,128,10,13,0,42]);
  for(const [kind,mimeType] of [['IMAGE','image/png'],['AUDIO','audio/wav'],['AUDIO','audio/mpeg'],['VIDEO','video/mp4']] as const){
   const block=nativeMediaBlock(kind,mimeType,bytes);expect(nativeMediaMetadata(block)).toEqual({kind:'native_media',modality:kind,mimeType,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
 });
 it('rejects remote references, wrong modalities, noncanonical base64 and extra prompt-bearing fields',()=>{
  for(const block of [{type:'image_url',image_url:{url:'https://untrusted.example/a.png'}},{type:'video_url',video_url:{url:'data:image/png;base64,YQ=='}},{type:'input_audio',input_audio:{format:'wav',data:'YQ'}},{type:'image_url',image_url:{url:'data:image/png;base64,YQ==',caption:'hidden instruction'}}] as JsonValue[])expect(()=>nativeMediaMetadata(block)).toThrow('NATIVE_MEDIA_BLOCK_INVALID');
 });
 it('fails closed on unsupported formats and bounded transport size',()=>{
  expect(()=>nativeMediaBlock('AUDIO','audio/ogg',Buffer.from('data'))).toThrow('FORMAT_UNSUPPORTED');
  expect(()=>nativeMediaBlock('VIDEO','video/mp4',new Uint8Array(NATIVE_MEDIA_MAX_BYTES+1))).toThrow('BUDGET_EXCEEDED');
 });
});
