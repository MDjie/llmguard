import {pcmFromMetadata, type PcmParameters} from './formats/pcm';
import type {TextEncoding} from './formats/text-decoder';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {z} from 'zod';
import {csrfHeaders} from '@/lib/auth/csrf-client';
import {validateMediaFileMetadata,normalizeMediaType,MEDIA_FORMAT_VERSION} from './formats/registry';
export interface UploadedMedia {artifactId:string;sha256:string;kind:string;name:string;sizeBytes:number;mediaType:string;}
const artifactSchema=z.object({id:z.string().uuid(),state:z.string(),partSize:z.number().int().positive(),partCount:z.number().int().positive(),failureCode:z.string().nullable().optional()});
export async function mediaJson(url:string,init:RequestInit={}):Promise<unknown>{
  const response=await fetch(url,{...init,headers:{...csrfHeaders(),...init.headers}});
  const raw:unknown=await response.json();
  if(!response.ok){const problem=z.object({detail:z.string().optional(),code:z.string().optional(),requestId:z.string().optional()}).passthrough().safeParse(raw);
    throw new Error(problem.success?[problem.data.detail??problem.data.code??'请求失败',problem.data.requestId].filter(Boolean).join(' · '):'请求失败');}
  return raw;
}
export async function waitWithSignal(ms:number,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('已取消','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});
}
export async function uploadMedia(file:File,signal:AbortSignal,onProgress:(state:string,percent:number,artifactId?:string)=>void,options:{idempotencyKey?:string;encoding?:TextEncoding;pcm?:PcmParameters}={}):Promise<UploadedMedia>{
  const {format,category}=validateMediaFileMetadata(file);
  const pcm = pcmFromMetadata(file.name, {pcm:options.pcm}, file.size);
  const hasher=sha256.create();
  try{for(let start=0;start<file.size;start+=4*1024**2){signal.throwIfAborted();hasher.update(new Uint8Array(await file.slice(start,start+4*1024**2).arrayBuffer()));onProgress('计算校验值',Math.round((start/file.size)*10));}}
  catch(error){hasher.destroy();throw error;}
  const digest=bytesToHex(hasher.digest()),mime=normalizeMediaType(file.type)||format.mimeTypes[0];
  const created=z.object({data:artifactSchema}).parse(await mediaJson('/api/v1/guard/artifacts/uploads',{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify({kind:category.toUpperCase(),fileName:file.name,mediaType:mime,sizeBytes:file.size,sha256:digest,idempotencyKey:options.idempotencyKey??'upload-'+crypto.randomUUID(),metadata:{formatVersion:MEDIA_FORMAT_VERSION,...(pcm?{pcm}:{}),...(category==='text'&&options.encoding?{encoding:options.encoding}:{})}})})).data;
  onProgress('上传中',10,created.id);
  if(['failed','quarantined','deleted'].includes(created.state)) throw new Error('文件验证失败，请移除后重新选择并核对格式与编码');
  if(created.state==='uploading'){
  const parts:Array<{partNumber:number;sizeBytes:number;sha256:string}>=[];
  for(let partNumber=1;partNumber<=created.partCount;partNumber++){
    signal.throwIfAborted();const part=file.slice((partNumber-1)*created.partSize,partNumber*created.partSize);
    const partDigest=bytesToHex(sha256(new Uint8Array(await part.arrayBuffer())));
    const result=z.object({data:z.object({partNumber:z.number(),sizeBytes:z.number(),sha256:z.string()})}).parse(await mediaJson(`/api/v1/guard/artifacts/${created.id}/parts/${partNumber}/content`,{method:'PUT',signal,headers:{'content-type':'application/octet-stream'},body:part})).data;
    if(result.partNumber!==partNumber||result.sizeBytes!==part.size||result.sha256!==partDigest) throw new Error('分片校验失败');
    parts.push(result);onProgress('上传中',10+Math.round(partNumber/created.partCount*75),created.id);
  }
  await mediaJson(`/api/v1/guard/artifacts/${created.id}/complete`,{method:'POST',signal,headers:{'content-type':'application/json'},body:JSON.stringify({parts})});
  }
  for(let attempt=0;attempt<150;attempt++){
    const current=z.object({data:artifactSchema}).parse(await mediaJson(`/api/v1/guard/artifacts/${created.id}`,{signal})).data;
    if(current.state==='accepted'){onProgress('已验证，待检测',100,created.id);return {artifactId:created.id,sha256:digest,kind:category.toUpperCase(),name:file.name,sizeBytes:file.size,mediaType:mime};}
    if(['failed','quarantined','deleted'].includes(current.state)) throw new Error(current.failureCode??'文件验证失败');
    onProgress('验证文件完整性',90,created.id);await waitWithSignal(5000,signal);
  }
  throw new Error('文件验证仍未完成，请在任务中查询状态');
}
