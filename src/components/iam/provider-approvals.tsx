'use client';
import { useCallback,useEffect,useState,type FormEvent } from 'react';
import { z } from 'zod';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card,CardHeader,CardContent,CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { usePermissions } from '@/hooks/use-permissions';
import { iamFetch } from '@/lib/iam/client';
import { toast } from 'sonner';
const listSchema=z.object({items:z.array(z.object({id:z.string(),requesterId:z.string(),providerId:z.string(),
  status:z.string(),reason:z.string(),payload:z.record(z.string(),z.unknown()),payloadDigest:z.string()}))});
export function ProviderApprovals({userId}:{userId:string}){
  const can=usePermissions();
  const [rows,setRows]=useState<z.infer<typeof listSchema>['items']>([]),[providerId,setProviderId]=useState(''),[reason,setReason]=useState('');
  const [target,setTarget]=useState(false),[judge,setJudge]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const load=useCallback(async()=>{try{setRows((await iamFetch('/api/providers/approvals',listSchema)).items);setError('');}
    catch(cause){setError(cause instanceof Error?cause.message:'读取失败');}},[]);
  useEffect(()=>{void load();},[load]);
  async function act(method:string,body:unknown){setBusy(true);try{await iamFetch('/api/providers/approvals',z.object({success:z.boolean()}),{method,body:JSON.stringify(body)});toast.success('模型审批操作已保存');await load();}
    catch(cause){toast.error(cause instanceof Error?cause.message:'操作失败');}finally{setBusy(false);}}
  function request(event:FormEvent<HTMLFormElement>){event.preventDefault();void act('POST',{providerId,reason,isDefaultTarget:target,isDefaultJudge:judge});}
  return <Card><CardHeader><CardTitle>模型上线审批</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm text-muted-foreground">配置或凭据变更后模型保持停用，审批通过才可上线。申请绑定具体配置和版本。</p>
    {error&&<p role="alert" className="text-destructive">{error}</p>}
    {rows.map(row=><div key={row.id} className="space-y-2 rounded-md border p-4 text-sm"><p>{row.reason} · {row.status}</p>
      <p className="break-all text-muted-foreground">模型：{row.providerId} · 申请人：{row.requesterId}</p>
      <details><summary className="cursor-pointer">核对模型配置</summary><pre className="overflow-auto p-2 text-xs">{JSON.stringify(row.payload,null,2)}</pre><p className="break-all text-xs">{row.payloadDigest}</p></details>
      {row.status==='pending'&&row.requesterId!==userId&&can('policy:approve')&&<div className="flex gap-2"><Button disabled={busy} onClick={()=>void act('PATCH',{id:row.id,decision:'approve'})}>批准上线</Button><Button variant="outline" disabled={busy} onClick={()=>void act('PATCH',{id:row.id,decision:'reject'})}>拒绝</Button></div>}
    </div>)}
    {can('provider:manage')&&<form onSubmit={request} className="grid gap-3 rounded-md border p-4"><Label htmlFor="provider-approval-id">模型 ID（从模型管理复制）</Label><Input required id="provider-approval-id" value={providerId} onChange={e=>setProviderId(e.target.value)}/>
      <Label htmlFor="provider-approval-reason">上线理由</Label><Textarea required minLength={5} id="provider-approval-reason" value={reason} onChange={e=>setReason(e.target.value)}/>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={target} onChange={e=>setTarget(e.target.checked)}/>设为默认目标模型</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={judge} onChange={e=>setJudge(e.target.checked)}/>设为默认裁判模型</label>
      <Button disabled={busy} type="submit">提交模型上线申请</Button></form>}
    <div className="flex flex-wrap gap-4 text-sm text-primary"><Link href="/whitelist">白名单审批</Link><Link href="/dictionaries">词典审批</Link><Link href="/response-templates">响应模板审批</Link><Link href="/policy-releases">策略发布审批</Link><Link href="/export">导出审批</Link></div>
  </CardContent></Card>;
}
