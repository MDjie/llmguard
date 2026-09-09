'use client';
import { useCallback,useEffect,useState,type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { iamFetch,roleLabels } from '@/lib/iam/client';
import { useAccessProfile } from '@/hooks/use-permissions';
import { toast } from 'sonner';
import { ProviderApprovals } from '@/components/iam/provider-approvals';
const rowSchema=z.object({id:z.string(),kind:z.string(),targetUserId:z.string(),requesterId:z.string(),
  status:z.string(),reason:z.string(),payloadDigest:z.string(),details:z.record(z.string(),z.unknown()),
  expiresAt:z.string(),decisions:z.array(z.object({actorId:z.string(),role:z.string(),decision:z.string(),at:z.string()}))});
const responseSchema=z.object({success:z.boolean(),items:z.array(rowSchema)});
export default function IamApprovalsPage(){
  const {can,deploymentMode}=useAccessProfile();
  const implementationAdmin=deploymentMode==='implementation'&&can('iam:users:manage');
  const [rows,setRows]=useState<z.infer<typeof rowSchema>[]>([]),[error,setError]=useState('');
  const [userId,setUserId]=useState(''),[busy,setBusy]=useState(false),[target,setTarget]=useState(''),[reason,setReason]=useState(''),[duration,setDuration]=useState(15);
  const reload=useCallback(async()=>{
    try{const data=await iamFetch('/api/iam/changes',responseSchema);setRows(data.items);setError('');}
    catch(cause){setError(cause instanceof Error?cause.message:'加载失败');}
  },[]);
  useEffect(()=>{void reload();void iamFetch('/api/auth/me',z.object({user:z.object({id:z.string()})})).then(data=>setUserId(data.user.id)).catch(()=>undefined);},[reload]);
  async function decide(id:string,decision:'approve'|'reject'){
    setBusy(true);try{await iamFetch('/api/iam/changes',z.object({success:z.boolean()}),{method:'PATCH',body:JSON.stringify({id,decision})});toast.success('审批结果已保存');await reload();}
    catch(cause){toast.error(cause instanceof Error?cause.message:'审批失败');}finally{setBusy(false);}
  }
  async function requestRecovery(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);try{await iamFetch('/api/iam/recovery',z.object({success:z.boolean()}),{method:'POST',body:JSON.stringify({targetUserId:target,reason,durationMinutes:duration})});toast.success('已提交应急访问申请');setReason('');await reload();}
    catch(cause){toast.error(cause instanceof Error?cause.message:'提交失败');}finally{setBusy(false);}
  }
  return <div className="space-y-5 p-6"><div className="flex justify-between"><div><h1 className="text-2xl font-semibold">授权审批</h1><p className="mt-1 text-sm text-muted-foreground">{implementationAdmin?'实施测试模式：可确认自己提交的非应急申请，目标账户仍须为他人。':'审批与申请、目标账户相互独立。'}应急访问需要两名不同角色的审批人。</p></div><Button variant="outline" onClick={()=>void reload()}>刷新</Button></div>
    {error&&<p role="alert" className="text-destructive">{error}</p>}
    <ProviderApprovals userId={userId}/>
    {!rows.length&&!error&&<Card><CardContent className="p-8 text-center text-muted-foreground">暂无权限变更申请</CardContent></Card>}
    {rows.map(row=>{
      const recovery=row.kind==='EMERGENCY_ACCESS';
      const allowed=row.status==='pending'&&(row.requesterId!==userId||(!recovery&&implementationAdmin))&&row.targetUserId!==userId&&!row.decisions.some(item=>item.actorId===userId)&&can(recovery?'iam:recovery:approve':'iam:changes:approve');
      return <Card key={row.id}><CardHeader><CardTitle className="flex items-center justify-between text-base">{recovery?'应急访问':row.kind==='PRIVILEGED_ACTIVATION'?'管理员账户启用':'权限变更'}<Badge variant="outline">{{pending:'待审批',approved:'已通过',rejected:'已拒绝',expired:'已过期'}[row.status]??row.status}</Badge></CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm"><p>理由：{row.reason}</p><p className="break-all text-muted-foreground">目标账户：{row.targetUserId}<br/>申请人：{row.requesterId}<br/>有效期至：{row.expiresAt}</p>
          <details><summary className="cursor-pointer font-medium">核对变更内容</summary><pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(row.details,null,2)}</pre><p className="mt-2 break-all text-xs text-muted-foreground">内容摘要：{row.payloadDigest}</p></details>
          {row.decisions.map(item=><p key={item.actorId}>{roleLabels[item.role]??item.role} · {item.actorId} · {item.decision==='approve'?'通过':'拒绝'}</p>)}
          {allowed&&<div className="flex gap-2"><Button disabled={busy} onClick={()=>void decide(row.id,'approve')}>确认内容并通过</Button><Button disabled={busy} variant="outline" onClick={()=>void decide(row.id,'reject')}>拒绝</Button></div>}
        </CardContent></Card>;
    })}
    {can('iam:recovery:approve')&&<Card><CardHeader><CardTitle className="text-base">申请临时应急访问</CardTitle></CardHeader><CardContent><form className="grid gap-4" onSubmit={requestRecovery}>
      <div><Label htmlFor="recovery-target">应急账户 ID</Label><Input id="recovery-target" required value={target} onChange={e=>setTarget(e.target.value)}/></div>
      <div><Label htmlFor="recovery-duration">访问时长（5–60 分钟）</Label><Input id="recovery-duration" type="number" min={5} max={60} required value={duration} onChange={e=>setDuration(Number(e.target.value))}/></div>
      <div><Label htmlFor="recovery-reason">应急理由与工单说明</Label><Textarea id="recovery-reason" minLength={10} required value={reason} onChange={e=>setReason(e.target.value)}/></div>
      <Button disabled={busy} type="submit">提交双人审批</Button>
    </form></CardContent></Card>}
  </div>;
}
