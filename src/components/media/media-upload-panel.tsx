'use client';
import {useEffect,useRef,useState,useCallback} from 'react';
import {Upload,Mic,Square,X,RotateCcw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {pcmFromMetadata,type PcmParameters} from '@/lib/media/formats/pcm';
import type {TextEncoding} from '@/lib/media/formats/text-decoder';
import {Progress} from '@/components/ui/progress';
import {MEDIA_ACCEPT,MAX_ATTACHMENTS,MAX_ATTACHMENT_TOTAL_BYTES,validateMediaFileMetadata} from '@/lib/media/formats/registry';
import {uploadMedia,mediaJson,type UploadedMedia} from '@/lib/media/upload-client';
interface Item {pcm?:PcmParameters;encoding?:TextEncoding;id:string;file:File;state:string;progress:number;result?:UploadedMedia;artifactId?:string;error?:string;}
export function MediaUploadPanel({onChange,onBusyChange,disabled=false,recordAudio=false}:{onChange:(items:UploadedMedia[])=>void;onBusyChange?:(busy:boolean)=>void;disabled?:boolean;recordAudio?:boolean}){
  const [pcmRate,setPcmRate]=useState(''),[pcmChannels,setPcmChannels]=useState(''),[pcmFormat,setPcmFormat]=useState('');
  const [encoding,setEncoding]=useState<TextEncoding|'auto'>('auto');
  const [items,setItems]=useState<Item[]>([]),[error,setError]=useState(''),[recording,setRecording]=useState(false);
  const controllers=useRef(new Map<string,AbortController>()),recorder=useRef<MediaRecorder|null>(null),activeItems=useRef<Item[]>([]),alive=useRef(true);
  useEffect(()=>{activeItems.current=items;onChange(items.flatMap(item=>item.result?[item.result]:[]));onBusyChange?.(items.some(item=>!item.result&&!item.error)||recording);},[items,onChange,onBusyChange,recording]);
  useEffect(()=>{alive.current=true;const running=controllers.current;return()=>{alive.current=false;for(const controller of running.values())controller.abort();const current=recorder.current;if(current?.state==='recording')current.stop();current?.stream.getTracks().forEach(track=>track.stop());};},[]);
  const patch=useCallback((id:string,change:Partial<Item>)=>setItems(current=>current.map(item=>item.id===id?{...item,...change}:item)),[]);
  const start=useCallback(async(item:Item)=>{
    if(!alive.current||!activeItems.current.some(value=>value.id===item.id)||controllers.current.has(item.id))return;
    const controller=new AbortController();controllers.current.set(item.id,controller);patch(item.id,{error:undefined,state:'等待上传',progress:0});
    try{const result=await uploadMedia(item.file,controller.signal,(state,progress,artifactId)=>patch(item.id,{state,progress,...(artifactId?{artifactId}:{})}),{idempotencyKey:'upload-'+item.id,encoding:item.encoding,pcm:item.pcm});patch(item.id,{result});}
    catch(cause){patch(item.id,{error:controller.signal.aborted?'已取消':cause instanceof Error?cause.message:'上传失败'});}
    finally{controllers.current.delete(item.id);}
  },[patch]);
  const add=useCallback((files:File[])=>{
    if(disabled)return;
    try{const current=activeItems.current;if(current.length+files.length>MAX_ATTACHMENTS)throw new Error(`每次最多 ${MAX_ATTACHMENTS} 个附件`);
      if([...current.map(item=>item.file),...files].reduce((sum,file)=>sum+file.size,0)>MAX_ATTACHMENT_TOTAL_BYTES)throw new Error('附件总大小超过 500 MiB');
      files.forEach(file=>validateMediaFileMetadata(file));
      const added=files.map(file=>({id:crypto.randomUUID(),pcm:pcmFromMetadata(file.name,{pcm:{sampleRate:Number(pcmRate),channels:Number(pcmChannels),sampleFormat:pcmFormat}},file.size),encoding:encoding==='auto'?undefined:encoding,file,state:'等待上传',progress:0}));activeItems.current=[...current,...added];setItems(activeItems.current);setError('');
      // Bound browser memory and upload concurrency; each file is streamed in chunks.
      void (async()=>{for(const item of added)await start(item);})();
    }catch(cause){setError(cause instanceof Error?cause.message:'文件不可用');}
  },[disabled,start,encoding,pcmRate,pcmChannels,pcmFormat]);
  async function record(){
    let acquired:MediaStream|undefined;
    try{if(recording){recorder.current?.stop();return;}
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});acquired=stream;if(!alive.current){stream.getTracks().forEach(track=>track.stop());return;}const selected=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
      const instance=new MediaRecorder(stream,selected?{mimeType:selected}:undefined),chunks:BlobPart[]=[];recorder.current=instance;
      let recordedBytes=0;const stopTimer=setTimeout(()=>{if(instance.state==='recording')instance.stop();},30*60_000);
      instance.ondataavailable=event=>{if(event.data.size){recordedBytes+=event.data.size;chunks.push(event.data);if(recordedBytes>100*1024*1024&&instance.state==='recording')instance.stop();}};
      instance.onstop=()=>{clearTimeout(stopTimer);stream.getTracks().forEach(track=>track.stop());if(!alive.current)return;setRecording(false);const type=instance.mimeType;const extension=type.includes('ogg')?'ogg':type.includes('mp4')?'m4a':'webm';add([new File(chunks,'录音.'+extension,{type})]);};
      instance.start(1000);setRecording(true);
    }catch(cause){acquired?.getTracks().forEach(track=>track.stop());if(alive.current){setRecording(false);setError(cause instanceof Error?cause.message:'无法使用麦克风');}}
  }
  function remove(item:Item){controllers.current.get(item.id)?.abort();if(item.artifactId&&!item.result)void mediaJson(`/api/v1/guard/artifacts/${item.artifactId}`,{method:'DELETE'}).catch(()=>undefined);activeItems.current=activeItems.current.filter(value=>value.id!==item.id);setItems(activeItems.current);}
  return <section className="space-y-3 rounded-lg border border-dashed p-3" aria-label="多模态附件" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();add(Array.from(event.dataTransfer.files));}}>
    <div className="flex items-center gap-2"><Upload className="size-4"/><Input type="file" multiple accept={MEDIA_ACCEPT} disabled={disabled} aria-label="选择文本、文档、图片、音频或视频" onChange={event=>{add(Array.from(event.target.files??[]));event.target.value='';}}/>{recordAudio&&<Button type="button" variant="outline" disabled={disabled} onClick={()=>void record()} aria-label={recording?'停止录音':'开始录音'}>{recording?<Square className="size-4"/>:<Mic className="size-4"/>}{recording?'停止':'录音'}</Button>}</div>
    <Select value={encoding} disabled={disabled||items.length>0} onValueChange={value=>setEncoding(value as TextEncoding|'auto')}><SelectTrigger className="w-64" aria-label="文本文件编码"><SelectValue/></SelectTrigger><SelectContent>{[['auto','UTF-8 / 自动识别 BOM'],['utf-8','UTF-8'],['utf-16le','UTF-16 小端'],['utf-16be','UTF-16 大端'],['gb18030','GB18030（明确指定）']].map(([value,label])=><SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
    <details className="text-xs text-muted-foreground"><summary>原始 PCM 音频参数（选择 .pcm 前填写）</summary><div className="mt-2 flex flex-wrap gap-2"><Input className="w-36" aria-label="PCM 采样率" placeholder="采样率 Hz" type="number" min={8000} max={192000} value={pcmRate} disabled={disabled} onChange={event=>setPcmRate(event.target.value)}/><Input className="w-28" aria-label="PCM 声道数" placeholder="声道 1–8" type="number" min={1} max={8} value={pcmChannels} disabled={disabled} onChange={event=>setPcmChannels(event.target.value)}/><Select value={pcmFormat} disabled={disabled} onValueChange={setPcmFormat}><SelectTrigger className="w-40" aria-label="PCM 采样格式"><SelectValue placeholder="位深与字节序"/></SelectTrigger><SelectContent>{['s16le','s16be','s24le','s24be','s32le','s32be','f32le','f32be'].map(value=><SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div></details>
    <p className="text-xs text-muted-foreground">支持文本、Office/PDF、图片及常见音视频格式。上传后校验真实格式，解析与检测能力由当前部署和策略决定。</p>
    {items.map(item=><div key={item.id} className="space-y-1 text-xs"><div className="flex items-center justify-between gap-2"><span className="break-all">{item.file.name} · {(item.file.size/1024/1024).toFixed(2)} MiB · {item.error??item.state}</span><span className="flex">{item.error&&<Button size="icon" variant="ghost" disabled={disabled} aria-label={'重试 '+item.file.name} onClick={()=>void start(item)}><RotateCcw className="size-3"/></Button>}<Button size="icon" variant="ghost" disabled={disabled} aria-label={'移除 '+item.file.name} onClick={()=>remove(item)}><X className="size-3"/></Button></span></div><Progress value={item.progress}/></div>)}
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
