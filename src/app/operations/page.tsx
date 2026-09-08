'use client';
import { useCallback,useEffect,useState } from 'react';
import { Card,CardHeader,CardTitle,CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table,TableHeader,TableHead,TableRow,TableBody,TableCell } from '@/components/ui/table';
import { apiErrorMessage } from '@/lib/api-client-error';
import type { inspectRuntime } from '@/lib/operations/inspection';
type Inspection=Awaited<ReturnType<typeof inspectRuntime>>;
const gib=(value:number|null)=>value===null?'未知':`${(value/1024**3).toFixed(2)} GiB`;
const metricNames:Record<string,string>={cpu:'CPU使用率',memory:'内存使用率',disk:'磁盘使用率',services:'后台服务'};
export default function OperationsPage(){
  const [data,setData]=useState<Inspection|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const load=useCallback(async(signal?:AbortSignal)=>{setLoading(true);setError('');try{const response=await fetch('/api/operations/inspection',{signal,cache:'no-store'});const payload=await response.json();if(!response.ok)throw new Error(apiErrorMessage(payload));if(!signal?.aborted)setData(payload.data as Inspection);}catch(failure){if(!signal?.aborted)setError(failure instanceof Error?failure.message:'巡检失败');}finally{if(!signal?.aborted)setLoading(false);}},[]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);const timer=setInterval(()=>void load(controller.signal),30000);return()=>{controller.abort();clearInterval(timer);};},[load]);
  return <div className="mx-auto max-w-7xl space-y-6 p-6"><div className="flex justify-between"><div><h1 className="text-2xl font-semibold">系统运维巡检</h1><p className="text-sm text-muted-foreground">每30秒采样，查看实例资源和后台服务状态</p></div><Button disabled={loading} onClick={()=>void load()}>{loading?'巡检中…':'立即巡检'}</Button></div>
    {error&&<p role="alert" className="text-red-600">{error} · 下方如有数据，为上次成功采样结果。</p>}
    {data&&<><p className="text-sm text-muted-foreground">中心：{data.site} · 实例：{data.instance} · 采样时间：{new Date(data.sampledAt).toLocaleString('zh-CN')}<br/>{data.scope}</p>
    <div className="grid gap-4 md:grid-cols-3"><Card><CardHeader><CardTitle>CPU</CardTitle></CardHeader><CardContent><p className="text-3xl">{data.cpu.usagePercent===null?'未知':data.cpu.usagePercent.toFixed(1)+'%'}</p><p>{data.cpu.count} 个逻辑核心</p></CardContent></Card><Card><CardHeader><CardTitle>内存</CardTitle></CardHeader><CardContent><p>可用 {gib(data.memory.availableBytes)} / 总量 {gib(data.memory.totalBytes)}</p><p>应用进程 {gib(data.memory.processRssBytes)}</p></CardContent></Card><Card><CardHeader><CardTitle>存储空间</CardTitle></CardHeader><CardContent><p>可用 {gib(data.disk.availableBytes)} / 总量 {gib(data.disk.totalBytes)}</p><p className="text-sm text-muted-foreground">应用工作目录所在文件系统</p></CardContent></Card></div>
    <Card><CardHeader><CardTitle>本实例服务</CardTitle></CardHeader><CardContent className="space-y-3">{data.services.map(service=><div key={service.name} className="flex gap-4"><strong>{service.name}</strong><Badge variant={service.status==='healthy'?'secondary':'destructive'}>{service.status==='healthy'?'正常':'异常'}</Badge><span>{service.message}</span></div>)}</CardContent></Card>
    <Card><CardHeader><CardTitle>集群资源与后台服务</CardTitle></CardHeader><CardContent><p className="mb-4 text-sm">{data.cluster.message}</p>{data.cluster.groups.map(group=><section className="mb-6" key={group.name}><h3 className="font-medium">{metricNames[group.name]??group.name}</h3>{group.status!=='available'?<p className="text-amber-700">{group.status==='empty'?'没有采样数据':'数据源查询失败'}</p>:<Table><TableHeader><TableRow><TableHead>节点或服务</TableHead><TableHead>数值 / 状态</TableHead><TableHead>采样</TableHead></TableRow></TableHeader><TableBody>{group.rows.map((row,index)=><TableRow key={index}><TableCell>{row.labels.instance??row.labels.job??'未知'} {row.labels.mountpoint??''}</TableCell><TableCell>{row.stale?'数据过期':row.value===null?'未知':group.name==='services'?row.value===1?'正常':'异常':row.value.toFixed(1)+'%'}</TableCell><TableCell>{new Date(row.sampledAt*1000).toLocaleString('zh-CN')}</TableCell></TableRow>)}</TableBody></Table>}</section>)}</CardContent></Card>
    </>}
  </div>;
}
