'use client';
import { useRef,useState } from 'react';
import Image from 'next/image';
import type { MediaAnnotation } from '@/contracts/http/media-evidence';
import { Button } from '@/components/ui/button';
export type {AuthorizedMedia} from '@/lib/evidence/media-preview';
import {authorizedMediaSchema,verifiedSeekSeconds,activeMediaAnnotations,type AuthorizedMedia} from '@/lib/evidence/media-preview';
export function AuthorizedMediaPreview({media}:{media:AuthorizedMedia}){
 const audio=useRef<HTMLAudioElement>(null),video=useRef<HTMLVideoElement>(null),[size,setSize]=useState<{width:number;height:number}|null>(null),[seekError,setSeekError]=useState(''),[mediaReady,setMediaReady]=useState(false),[position,setPosition]=useState(0);
 const checked=authorizedMediaSchema.safeParse(media);
 if(!checked.success)return <p role="alert" className="text-sm">授权媒体格式无法验证，请查看归档详情。</p>;
 const src='data:'+checked.data.mimeType+';base64,'+checked.data.dataBase64,annotations=checked.data.annotations??[];
 const seek=(annotation:MediaAnnotation)=>{const element=audio.current??video.current,seconds=verifiedSeekSeconds(annotation,element?.duration??NaN);if(!element||seconds===null){setSeekError('媒体尚未就绪或完整时间范围无法验证');return;}element.currentTime=seconds;setPosition(seconds);setSeekError('');};
 const active=activeMediaAnnotations(annotations,position);
 return <section className="space-y-2"><p className="text-xs text-muted-foreground">授权原件预览 · {media.mimeType}</p>
  {media.mimeType.startsWith('image/')?<div className="relative mx-auto" style={{width:size?Math.min(600,320*size.width/size.height):600,maxWidth:'100%'}}><Image unoptimized loading="eager" src={src} width={size?.width??600} height={size?.height??360} alt="授权查看的原始图片" className="block h-auto w-full" onLoad={event=>setSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})}/>{size&&annotations.some(item=>item.region)&&<svg aria-label="已验证命中区域" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">{annotations.map((item,index)=>item.region?<rect key={index} x={item.region[0]} y={item.region[1]} width={item.region[2]-item.region[0]} height={item.region[3]-item.region[1]} fill="rgba(251,191,36,0.18)" stroke="#dc2626" strokeWidth="2" vectorEffect="non-scaling-stroke"><title>{item.label+' · '+item.evidenceId}</title></rect>:null)}</svg>}</div>:media.mimeType.startsWith('audio/')?<audio ref={audio} onTimeUpdate={event=>setPosition(event.currentTarget.currentTime)} onLoadedMetadata={()=>setMediaReady(true)} onError={()=>setSeekError('当前浏览器无法解码音频，请使用支持此编码的浏览器；归档证据仍然保留。')} controls aria-label="授权原始音频" src={src} className="w-full"/>:<video ref={video} onTimeUpdate={event=>setPosition(event.currentTarget.currentTime)} onLoadedMetadata={()=>setMediaReady(true)} onError={()=>setSeekError('当前浏览器无法解码视频，请使用支持此编码的浏览器；归档证据仍然保留。')} controls aria-label="授权原始视频" src={src} className="max-h-80 w-full"/>}
  {annotations.some(item=>item.startMs!==undefined)&&<div className="space-y-2"><p className="text-xs text-muted-foreground">按检测片段定位，时间范围不代表逐字对齐。</p><div className="flex flex-wrap gap-2">{annotations.map((item,index)=>item.startMs!==undefined?<Button key={index} size="sm" variant="outline" disabled={!mediaReady} title={item.label+' · '+item.evidenceId} onClick={()=>seek(item)}>跳转 {(item.startMs/1000).toFixed(2)}—{((item.endMs??item.startMs)/1000).toFixed(2)} 秒</Button>:null)}</div></div>}{!!active.length&&<ul aria-label="当前播放位置关联证据" className="space-y-1 text-xs">{active.map((item,index)=><li key={index} className="break-all">证据 {item.evidenceId} · {item.label}</li>)}</ul>}{seekError&&<p role="status" className="text-sm">{seekError}</p>}
 </section>;
}
