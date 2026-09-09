 'use client';
import { useEffect,useState } from 'react';
import { z } from 'zod';
import { mediaEvidenceMetadataSchema } from '@/contracts/http/media-evidence';
import {OriginalPreviewPanel} from './original-preview-panel';
import { EvidenceAccessPanel } from './evidence-access-panel';
const responseSchema=z.object({items:z.array(mediaEvidenceMetadataSchema).max(1)});
export function MediaEvidencePanel({alertId}:{alertId:string}){
 const [items,setItems]=useState<z.infer<typeof mediaEvidenceMetadataSchema>[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{const controller=new AbortController();setLoading(true);setItems([]);setError('');
  fetch('/api/security-alerts/'+encodeURIComponent(alertId)+'/media-evidence',{signal:controller.signal,cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error('派生证据状态读取失败');const result=responseSchema.parse(await response.json());if(!controller.signal.aborted)setItems(result.items);}).catch(()=>{if(!controller.signal.aborted)setError('派生证据状态读取失败');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[alertId]);
 if(loading)return <p className="text-sm text-muted-foreground">正在查询派生证据…</p>;
 return <section className="space-y-3"><h3 className="text-sm font-medium">媒体派生证据</h3>{error&&<p role="alert">{error}</p>}{!items.length&&!error&&<p className="text-sm text-muted-foreground">没有可读取的派生档案；历史任务或未启用严格归档的任务无法还原未保存的转写。</p>}{items.map(item=><div key={item.id} className="space-y-2"><p className="text-sm">{item.state==='READY'?'派生文本已归档':item.state==='DELETED'?'派生档案已到期清理':'档案尚未就绪'}{item.errorCode?' · '+item.errorCode:''}</p>{item.state==='READY'&&<><EvidenceAccessPanel incidentId={item.id} sourceDigest={item.sourceDigest} resourceType="MEDIA_EVIDENCE"/><OriginalPreviewPanel snapshotId={item.id}/></>}</div>)}</section>;
}
