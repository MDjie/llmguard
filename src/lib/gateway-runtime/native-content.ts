import { createHash } from 'node:crypto';
import { GatewayError, type JsonValue } from './error';
export const NATIVE_MEDIA_MAX_BYTES=1048576;
export type NativeMediaKind='IMAGE'|'AUDIO'|'VIDEO';
export function nativeMediaBlock(kind:NativeMediaKind,mimeType:string,bytes:Uint8Array):Record<string,JsonValue>{
 if(!bytes.length||bytes.length>NATIVE_MEDIA_MAX_BYTES)throw new GatewayError('NATIVE_MEDIA_BUDGET_EXCEEDED',413);
 const base64=Buffer.from(bytes).toString('base64');
 if(kind==='IMAGE'&&['image/png','image/jpeg','image/webp','image/gif'].includes(mimeType))return{type:'image_url',image_url:{url:'data:'+mimeType+';base64,'+base64}};
 if(kind==='AUDIO'&&['audio/wav','audio/x-wav','audio/mpeg'].includes(mimeType))return{type:'input_audio',input_audio:{data:base64,format:mimeType==='audio/mpeg'?'mp3':'wav'}};
 if(kind==='VIDEO'&&mimeType==='video/mp4')return{type:'video_url',video_url:{url:'data:video/mp4;base64,'+base64}};
 throw new GatewayError('NATIVE_MEDIA_FORMAT_UNSUPPORTED',422);
}
export function nativeMediaMetadata(raw:JsonValue):{kind:'native_media';modality:NativeMediaKind;mimeType:string;sha256:string;bytes:number}{
 const invalid=()=>new GatewayError('NATIVE_MEDIA_BLOCK_INVALID',422);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw invalid();
 const field=raw.type==='image_url'?'image_url':raw.type==='input_audio'?'input_audio':raw.type==='video_url'?'video_url':null;
 if(!field||Object.keys(raw).length!==2)throw invalid();
 const inner=raw[field];if(!inner||typeof inner!=='object'||Array.isArray(inner))throw invalid();
 let modality:NativeMediaKind,mimeType:string,base64:string;
 if(field==='input_audio'){
  if(Object.keys(inner).length!==2||!['mp3','wav'].includes(String(inner.format))||typeof inner.data!=='string')throw invalid();
  modality='AUDIO';mimeType=inner.format==='mp3'?'audio/mpeg':'audio/wav';base64=inner.data;
 }else{
  if(Object.keys(inner).length!==1||typeof inner.url!=='string')throw invalid();
  const match=/^data:((?:image\/(?:png|jpeg|webp|gif))|video\/mp4);base64,([A-Za-z0-9+/]*={0,2})$/.exec(inner.url);
  if(!match)throw invalid();mimeType=match[1];modality=field==='image_url'?'IMAGE':'VIDEO';if((modality==='IMAGE')!==mimeType.startsWith('image/'))throw invalid();base64=match[2];
 }
 if(!base64||base64.length>Math.ceil(NATIVE_MEDIA_MAX_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw invalid();
 const bytes=Buffer.from(base64,'base64');if(!bytes.length||bytes.length>NATIVE_MEDIA_MAX_BYTES||bytes.toString('base64')!==base64)throw invalid();
 return{kind:'native_media',modality,mimeType,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
}
