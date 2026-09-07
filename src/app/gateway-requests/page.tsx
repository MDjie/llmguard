'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Clock3, GitMerge, ShieldAlert, RefreshCw, Search } from 'lucide-react';
import { PageHeader } from '@/components/console/page-header';
import { MetricCard } from '@/components/console/metric-card';
import { DetailPanel } from '@/components/console/detail-panel';
import { EmptyState } from '@/components/console/empty-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { gatewayRequestListSchema, gatewayRequestDetailSchema, type GatewayRequestList, type GatewayRequestDetail } from '@/contracts/http/gateway-console';

const stateLabels: Record<string,string> = { AUTHORIZED:'已授权', SEND_INTENT:'已批准发送', UPSTREAM_STARTED:'模型处理中', RELEASING:'已批准释放', WRITTEN:'写出已确认', COMPLETED:'执行完成', TERMINATED:'已终止', REVIEW_REQUIRED:'待人工审核', UPSTREAM_OUTCOME_UNKNOWN:'上游结果待核实' };
const eventLabels: Record<string,string> = { UPSTREAM_SEND_INTENT:'输入通过 · 批准发送', UPSTREAM_SEND_STARTED:'开始调用模型', RELEASE_INTENT:'输出通过 · 批准释放', WRITE_ACCEPTED:'服务器确认写出', COMPLETED:'执行记录完成', TERMINATED:'请求终止' };
const stageLabels: Record<string,string> = { INPUT:'输入审核', INPUT_RECHECK:'输入替换复检', OUTPUT_COMPLETE:'完整输出审核', OUTPUT_RECHECK:'输出替换复检', OUTPUT_CHUNK:'流式窗口审核' };
const actions: Record<string,string> = { ALLOW:'允许',WARN:'告警放行',BLOCK:'阻断',MASK:'脱敏',REWRITE:'改写',SAFE_RESPONSE:'安全代答',REQUIRE_REVIEW:'人工审核' };
function stamp(value:string) { return value.replace('T',' ').slice(0,19)+' UTC'; }

export default function GatewayRequestsPage() {
  const [list,setList]=useState<GatewayRequestList|null>(null), [detail,setDetail]=useState<GatewayRequestDetail|null>(null);
  const [selected,setSelected]=useState(''), [state,setState]=useState('ALL'), [search,setSearch]=useState('');
  const [loading,setLoading]=useState(false), [error,setError]=useState(''), [detailError,setDetailError]=useState('');
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    setLoading(true);setError('');
    try { const response=await fetch('/api/gateway/requests'+(state==='ALL'?'':'?state='+state),{signal}); if(!response.ok)throw new Error('无法读取执行记录，请确认登录权限及网关数据库迁移状态。');setList(gatewayRequestListSchema.parse(await response.json())); }
    catch(error:unknown){if(!signal?.aborted)setError(error instanceof Error?error.message:'读取失败');}
    finally{if(!signal?.aborted)setLoading(false);}
  },[state]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[refresh]);
  useEffect(()=>{
    if(!selected)return; const controller=new AbortController();setDetail(null);setDetailError('');
    void fetch('/api/gateway/requests?id='+encodeURIComponent(selected),{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('执行详情读取失败');return gatewayRequestDetailSchema.parse(await response.json());}).then(setDetail).catch((error:unknown)=>{if(!controller.signal.aborted)setDetailError(error instanceof Error?error.message:'读取失败');});
    return()=>controller.abort();
  },[selected]);
  useEffect(()=>{const id=new URLSearchParams(window.location.search).get('request');if(id&&/^[a-zA-Z0-9_-]{1,128}$/.test(id))setSelected(id);},[]);
  const total=(states?:string[])=>list?list.totals.filter(row=>!states||states.includes(row.state)).reduce((sum,row)=>sum+row.count,0):'—';
  const items=list?.items.filter(row=>!search||row.id.includes(search)||row.sessionId?.includes(search))??[];
  return <div className="space-y-5">
    <PageHeader title="请求执行记录" description="从业务请求追溯检测、替换、模型调用与实际写出" actions={<><Button asChild variant="outline"><Link href="/applications">应用接入</Link></Button><Button variant="outline" onClick={()=>void refresh()} disabled={loading}><RefreshCw className="size-4"/>刷新</Button></>}/>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="近 24 小时业务请求" value={total()} icon={GitMerge} hint="按业务请求去重"/>
      <MetricCard label="执行完成" value={total(['COMPLETED'])} icon={CheckCircle2} tone="green" hint="已记录写出确认与完成事件"/>
      <MetricCard label="终止 / 待审核" value={total(['TERMINATED','REVIEW_REQUIRED'])} icon={ShieldAlert} tone="red" hint="查看检测结论与终止原因"/>
      <MetricCard label="上游结果待核实" value={total(['UPSTREAM_OUTCOME_UNKNOWN'])} icon={Clock3} tone="amber" hint="保留幂等记录，防止重复调用"/>
    </div>
    {error&&<p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="min-w-0 gap-0 py-0"><CardHeader className="flex flex-wrap items-center gap-3 border-b py-3 sm:flex-row"><CardTitle className="mr-auto">业务请求</CardTitle>
        <div className="relative w-full sm:w-60"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"/><Input aria-label="搜索请求或会话 ID" placeholder="请求 ID / 会话 ID" value={search} onChange={event=>setSearch(event.target.value)} className="pl-8"/></div>
        <Select value={state} onValueChange={setState}><SelectTrigger className="w-44" aria-label="请求状态"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="ALL">全部状态</SelectItem>{Object.entries(stateLabels).map(([value,label])=><SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
      </CardHeader><CardContent className="px-0">
        <Table><TableHeader><TableRow><TableHead className="pl-4">请求 / 时间</TableHead> <TableHead>执行状态</TableHead><TableHead>检测步骤</TableHead><TableHead>会话提交</TableHead></TableRow></TableHeader><TableBody>{items.map(row=><TableRow key={row.id} className={selected===row.id?'bg-blue-50/60':''}>
          <TableCell className="pl-4"><button className="max-w-52 truncate text-left font-mono text-xs text-primary hover:underline" onClick={()=>setSelected(row.id)}>{row.id}</button><p className="mt-1 text-[11px] text-muted-foreground">{stamp(row.createdAt)}</p></TableCell>
          <TableCell><Badge variant={row.state==='COMPLETED'?'outline':row.state==='TERMINATED'?'destructive':'secondary'}>{stateLabels[row.state]??row.state}</Badge></TableCell><TableCell className="tabular-nums">{row.stepCount}</TableCell><TableCell className="text-xs text-muted-foreground">{row.sessionFinalized?'已完成':'待完成'}</TableCell>
        </TableRow>)}</TableBody></Table>
        {!items.length&&<EmptyState title={loading?'正在读取执行记录':'暂无匹配请求'} description="完成应用接入后，经安全网关处理的请求将在此展示。"/>}
      </CardContent></Card>
      <DetailPanel title="执行详情" open={Boolean(selected)} onClose={()=>setSelected('')}>
        {detailError?<p role="alert" className="p-4 text-sm text-red-600">{detailError}</p>:!detail?<p className="p-4 text-sm text-muted-foreground">正在读取…</p>:<div className="space-y-5 p-4">
          <div><p className="text-xs text-muted-foreground">固定运行快照</p><p className="mt-1 break-all font-mono text-xs">{detail.request?.snapshotId}</p></div>
          {detail.resources&&<div className="rounded-md border p-3"><h2 className="text-sm font-semibold">资源结算</h2><div className="mt-3 grid grid-cols-2 gap-3 text-xs"><p>状态：{detail.resources.state==='RESERVED'?'执行中':detail.resources.state==='UNKNOWN'?'上游消耗待核实':'已结算'}</p><p>检测步骤：{detail.resources.inspectionSteps}</p><p>准备字符：{detail.resources.preparedInputChars??'未完成'}</p><p>授权引用：{detail.resources.preparedReferences??'未完成'}</p></div><p className="mt-3 text-[11px] leading-5 text-muted-foreground">字符按 UTF-16 计量，累计检测含复检与重叠窗口。模型 Token 和费用尚未测量，不按零计。</p></div>}
          <div><h2 className="mb-3 text-sm font-semibold">检测与处置</h2><div className="space-y-2">{detail.steps.map(step=><div key={step.id} className="rounded-md border p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{stageLabels[step.stage]??step.stage}</span><Badge variant={step.action==='BLOCK'?'destructive':'secondary'}>{step.action?actions[step.action]??step.action:step.status}</Badge></div><p className="mt-2 text-[11px] text-muted-foreground">覆盖：{step.coverage==='COMPLETE'?'完整':step.coverage==='PARTIAL'?'部分':'未确认'} · {step.latencyMs??'—'} ms</p><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{step.decisionId??step.id}</p></div>)}</div></div>
          <div><h2 className="mb-3 text-sm font-semibold">执行时间线</h2><ol className="space-y-4 border-l border-blue-100 pl-4">{detail.events.map(event=><li key={event.sequence} className="relative text-xs"><span className="absolute -left-[21px] top-1 size-2 rounded-full bg-primary"/><p className="font-medium">{eventLabels[event.kind]??event.kind}</p><p className="mt-1 text-[10px] text-muted-foreground">{stamp(event.createdAt)}</p>{event.actualAction&&<p className="mt-1 text-primary">实际动作：{actions[event.actualAction]??event.actualAction}</p>}{event.decisionId&&<p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">决策 {event.decisionId}</p>}{event.recheckDecisionId&&<p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">复检 {event.recheckDecisionId}</p>}{event.reasonCode&&<p className="mt-1 break-all text-amber-700">{event.reasonCode}</p>}{event.payloadHmac&&<p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={event.payloadHmac}>HMAC {event.payloadHmac}</p>}</li>)}</ol></div>
          <p className="rounded-md bg-blue-50 p-3 text-[11px] leading-5 text-muted-foreground">{detail.writeAcceptedMeaning}。本页展示执行元数据及指纹，不包含原始敏感正文。</p>
        </div>}
      </DetailPanel>
    </div>
  </div>;
}
