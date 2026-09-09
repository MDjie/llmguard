'use client';
import {useEffect,useState} from 'react';
import {originalSourcesResponseSchema} from '@/contracts/http/original-preview';
import type {z} from 'zod';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {EvidenceAccessPanel} from './evidence-access-panel';
function OriginalSource({snapshotId,source}:{snapshotId:string;source:z.infer<typeof originalSourcesResponseSchema>['items'][number]}){
 const pdf=source.mimeType==='application/pdf',[page,setPage]=useState(source.suggestedPages[0]??1);
 const resourceId=snapshotId+':'+source.artifactId+':'+(pdf?page:0);
 return <div className="space-y-2 rounded border p-3"><p className="text-sm">{source.kind} · {source.artifactId.slice(0,8)} · {(source.sizeBytes/1024/1024).toFixed(2)} MiB</p>
  {pdf&&<div className="space-y-1"><Label htmlFor={'original-page-'+source.artifactId}>申请查看的 PDF 页码</Label><Input id={'original-page-'+source.artifactId} aria-label="申请查看的 PDF 页码" type="number" min={1} max={2000} value={page} onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=1&&value<=2000)setPage(value);}} className="w-28"/><p className="text-xs text-muted-foreground">每次授权绑定一页；更换页码需要另行申请。已记录页面：{source.suggestedPages.join('、')||'未知'}</p></div>}
  <EvidenceAccessPanel key={resourceId} incidentId={resourceId} resourceType="MEDIA_ORIGINAL"/>
 </div>;
}
export function OriginalPreviewPanel({snapshotId}:{snapshotId:string}){
 const [items,setItems]=useState<z.infer<typeof originalSourcesResponseSchema>['items']>([]),[status,setStatus]=useState('正在读取原件预览范围…');
 useEffect(()=>{const controller=new AbortController();setItems([]);setStatus('正在读取原件预览范围…');
  fetch('/api/media-evidence/'+encodeURIComponent(snapshotId)+'/originals',{signal:controller.signal,cache:'no-store'}).then(async response=>{
   if(!response.ok)throw new Error(response.status===403?'当前账号没有原件读取权限。':'原件范围暂不可用。');
   const value=originalSourcesResponseSchema.parse(await response.json());if(controller.signal.aborted)return;
   setItems(value.items);setStatus(value.items.length?'':'没有当前可预览的原件；源文件可能已到期、格式暂不支持或超过预览预算。');
  }).catch((error:unknown)=>{if(!controller.signal.aborted)setStatus(error instanceof Error?error.message:'原件范围暂不可用。');});
  return()=>controller.abort();
 },[snapshotId]);
 return <section className="space-y-2" aria-label="独立原件审批"><h4 className="text-sm font-medium">原件和 PDF 页面</h4><p className="text-xs text-muted-foreground">此处申请单独的原件权限。派生文本审批不会开放原件。</p>{status&&<p role="status" className="text-xs text-muted-foreground">{status}</p>}{items.map(source=><OriginalSource key={source.artifactId} snapshotId={snapshotId} source={source}/>)}</section>;
}
