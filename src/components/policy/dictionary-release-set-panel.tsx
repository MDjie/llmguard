'use client';

import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { csrfHeaders } from '@/lib/auth/csrf-client';

const rowSchema=z.object({id:z.string(),policyId:z.string(),dictionaryId:z.string(),version:z.string(),state:z.string(),
  revision:z.number().int(),contentHash:z.string(),shardCount:z.number().int(),previousSetId:z.string().nullable(),
  submittedBy:z.string(),approvedBy:z.string().nullable()});
type Row=z.infer<typeof rowSchema>;
type Operation='approve'|'shadow'|'canary'|'activate'|'rollback';
const labels:Record<Operation,string>={approve:'整组审批',shadow:'登记 SHADOW',canary:'登记 CANARY',activate:'整组设为编译源',rollback:'整组回滚编译源'};
async function payload(response:Response):Promise<unknown> {
  const value:unknown=await response.json();
  if(!response.ok) {
    const error=z.object({detail:z.string().optional(),title:z.string().optional()}).safeParse(value);
    throw new Error(error.success ? error.data.detail ?? error.data.title ?? '操作失败' : '操作失败');
  }
  return value;
}

export function DictionaryReleaseSetPanel({onChanged}:{readonly onChanged:()=>Promise<void>}) {
  const [rows,setRows]=useState<Row[]>([]);
  const [file,setFile]=useState<File|null>(null);
  const [working,setWorking]=useState(false);
  const [loadError,setLoadError]=useState('');
  const [pending,setPending]=useState<{row:Row;operation:Operation}|null>(null);
  const [reason,setReason]=useState('');
  const load=useCallback(async()=>{
    try {
      const result=await payload(await fetch('/api/policy-governance/release-sets',{cache:'no-store'}));
      setRows(z.object({data:z.object({items:z.array(rowSchema)})}).parse(result).data.items);setLoadError('');
    }catch(error){setLoadError(error instanceof Error ? error.message : '词库集合加载失败');}
  },[]);
  useEffect(()=>{void load();},[load]);
  async function importFile() {
    if(!file)return;
    setWorking(true);
    try {
      if(file.size>15*1024*1024)throw new Error('制品文件不能超过 15 MiB；不要拆开集合逐片导入。');
      const artifact:unknown=JSON.parse(await file.text());
      await payload(await fetch('/api/policy-governance/release-sets',{method:'POST',
        headers:{'content-type':'application/json',...csrfHeaders()},body:JSON.stringify({artifact})}));
      toast.success('整组草稿导入完成；尚未审批或切换流量');
      setFile(null);await load();await onChanged();
    }catch(error){toast.error(error instanceof Error ? error.message : '导入失败');}
    finally{setWorking(false);}
  }
  async function operate() {
    if(!pending || !reason.trim())return;
    setWorking(true);
    try {
      await payload(await fetch('/api/policy-governance/release-sets/'+pending.row.id+'/'+pending.operation,{method:'POST',
        headers:{'content-type':'application/json',...csrfHeaders()},
        body:JSON.stringify({expectedRevision:pending.row.revision,reason:reason.trim()})}));
      toast.success('整组状态更新完成；实时策略绑定未改变');setPending(null);await load();await onChanged();
    }catch(error){toast.error(error instanceof Error ? error.message : '操作失败；请刷新版本');}
    finally{setWorking(false);}
  }
  return <Card>
    <CardHeader><CardTitle>整组词库发布</CardTitle><CardDescription>一个独立制品包含全部分片。导入只创建草稿，必须由不同账号审批；SHADOW / CANARY 仅登记词库状态，真实流量由签名策略包发布控制。</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap items-end gap-3"><div className="space-y-2"><Label htmlFor="release-set-artifact">已审核 release-set JSON 制品（最多 15 MiB）</Label><Input id="release-set-artifact" type="file" accept=".json,application/json" disabled={working} onChange={event=>setFile(event.target.files?.[0] ?? null)} /></div>
        <Button disabled={!file || working} onClick={()=>void importFile()}>整组导入草稿</Button><Button variant="outline" disabled={working} onClick={()=>void load()}>刷新集合</Button></div>
      {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
      {!loadError && rows.length===0 && <p className="text-sm text-muted-foreground">暂无整组词库。未审核候选不能直接发布。</p>}
      <div className="space-y-3">{rows.map(row=>{
        const operations:Operation[]=row.state==='draft'?['approve']:row.state==='reviewed'?['shadow','canary']:
          ['shadow','canary'].includes(row.state)?['activate']:row.state==='active' && row.previousSetId?['rollback']:[];
        return <div key={row.id} className="rounded-md border p-3 space-y-2">
          <div className="flex flex-wrap gap-2 items-center"><strong>{row.dictionaryId} · {row.version}</strong><Badge variant="outline">{row.state}</Badge><span className="text-sm">{row.shardCount} 片 · revision {row.revision}</span></div>
          <p className="break-all text-xs text-muted-foreground">策略 {row.policyId} · 提交 {row.submittedBy} · 审批 {row.approvedBy ?? '待独立审核'}</p>
          <p className="break-all font-mono text-xs">{row.contentHash}</p>
          <div className="flex flex-wrap gap-2">{operations.map(operation=><Button key={operation} size="sm" variant={operation==='rollback'?'destructive':'outline'} disabled={working} onClick={()=>{setPending({row,operation});setReason('');}}>{labels[operation]}</Button>)}</div>
        </div>;
      })}</div>
      <p className="text-xs text-muted-foreground">显示最近 200 个集合版本；下方分片仅查看，不允许单独流转。</p>
      <Dialog open={pending!==null} onOpenChange={open=>{if(!open && !working)setPending(null);}}><DialogContent><DialogHeader>
        <DialogTitle>{pending?labels[pending.operation]:'词库集合操作'}</DialogTitle><DialogDescription>{pending?.row.dictionaryId} · {pending?.row.version} · revision {pending?.row.revision}。操作整个集合，不切换当前实时策略。</DialogDescription>
      </DialogHeader><Label htmlFor="release-set-reason">审核依据或操作理由</Label><Textarea id="release-set-reason" maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} /><DialogFooter><Button variant="outline" disabled={working} onClick={()=>setPending(null)}>取消</Button><Button disabled={working || !reason.trim()} onClick={()=>void operate()}>确认整组操作</Button></DialogFooter></DialogContent></Dialog>
    </CardContent>
  </Card>;
}
