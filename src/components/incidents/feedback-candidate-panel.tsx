'use client';
import { useCallback,useEffect,useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select';
import { EvidenceAccessPanel } from './evidence-access-panel';
const sourceSchema=z.object({id:z.string(),resourceType:z.enum(['MEDIA_EVIDENCE','ARCHIVED_CONTENT']),sourceDigest:z.string(),label:z.string()});
const pageSchema=z.object({items:z.array(sourceSchema),hasMore:z.boolean(),nextAfterId:z.string().nullable()});
export function FeedbackCandidatePanel({alertId,feedbackId}:{alertId:string;feedbackId:string}){
 const [items,setItems]=useState<z.infer<typeof sourceSchema>[]>([]),[selected,setSelected]=useState(''),[next,setNext]=useState<string|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const load=useCallback(async(after?:string,signal?:AbortSignal)=>{setLoading(true);setError('');try{const response=await fetch('/api/security-alerts/'+encodeURIComponent(alertId)+'/feedback/candidate'+(after?'?afterId='+after:''),{signal,cache:'no-store'});if(!response.ok)throw new Error('候选来源读取失败，请检查原文访问权限');const page=pageSchema.parse(await response.json());if(!signal?.aborted){setItems(prior=>after?[...prior,...page.items]:page.items);setNext(page.nextAfterId);}}catch(error:unknown){if(!signal?.aborted)setError(error instanceof Error?error.message:'读取失败');}finally{if(!signal?.aborted)setLoading(false);}},[alertId]);
 useEffect(()=>{const controller=new AbortController();setItems([]);setSelected('');void load(undefined,controller.signal);return()=>controller.abort();},[load]);
 const source=items.find(item=>item.id===selected);
 return <section className="mt-3 space-y-3 rounded border p-3"><h4 className="font-medium">反馈转评测候选</h4><p className="text-xs text-muted-foreground">选择已归档的文本来源，以“误报申诉”用途申请独立审批。批准后直接生成候选包会消费该授权。</p>{error&&<p role="alert">{error}</p>}{!items.length&&!loading&&!error&&<p className="text-sm text-muted-foreground">当前反馈没有可用的归档来源，无法还原未保存的原文。</p>}{items.length>0&&<Select value={selected} onValueChange={setSelected}><SelectTrigger aria-label="评测候选归档来源"><SelectValue placeholder="选择归档版本"/></SelectTrigger><SelectContent>{items.map(item=><SelectItem key={item.id} value={item.id}>{item.label} · {item.id.slice(0,8)}</SelectItem>)}</SelectContent></Select>}{next&&<Button variant="outline" disabled={loading} onClick={()=>void load(next)}>加载更多来源</Button>}{source&&<EvidenceAccessPanel key={source.id} incidentId={source.id} sourceDigest={source.sourceDigest} resourceType={source.resourceType} candidate={{alertId,feedbackId}}/>}</section>;
}
