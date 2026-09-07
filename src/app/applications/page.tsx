'use client';

import { PublicationStatus } from '@/components/console/publication-status';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { Building2, CheckCircle2, Circle, KeyRound, Layers, RefreshCw, Save, Plus, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/console/page-header';
import { MetricCard } from '@/components/console/metric-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { applicationListResponseSchema, applicationResponseSchema, credentialListResponseSchema, createdApplicationCredentialResponseSchema, updateApplicationSchema } from '@/contracts/http/tenancy';
import { onboardingSchema } from '@/contracts/http/gateway-onboarding';

const onboardingLabels={DRAFT:'待配置',CONFIGURED:'待验证',CONNECTED:'已连接',VERIFIED:'已验证',ENFORCING:'防护中',DEGRADED:'接入异常'} as const;

type Application=z.infer<typeof applicationResponseSchema>;
type Onboarding=z.infer<typeof onboardingSchema>;
type Credential=z.infer<typeof credentialListResponseSchema>['items'][number];
type Form={name:string;owner:string;department:string;environment:string;dataClass:string;routes:string};
const blank:Form={name:'',owner:'',department:'',environment:'development',dataClass:'internal',routes:''};
async function jsonRequest(url:string,options?:RequestInit):Promise<unknown>{const response=await fetch(url,options);const value:unknown=await response.json();if(!response.ok){const problem=z.object({detail:z.string().optional(),title:z.string().optional()}).safeParse(value);throw new Error(problem.success?problem.data.detail??problem.data.title??'操作失败':'操作失败，请检查权限或配置');}return value;}

export default function ApplicationsPage(){
  const [apps,setApps]=useState<Application[]>([]),[current,setCurrent]=useState(''),[onboarding,setOnboarding]=useState<Onboarding|null>(null),[credentials,setCredentials]=useState<Credential[]>([]);
  const [form,setForm]=useState<Form>(blank),[permissions,setPermissions]=useState<string[]>([]),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const [createOpen,setCreateOpen]=useState(false),[createName,setCreateName]=useState(''),[createCode,setCreateCode]=useState(''),[keyOpen,setKeyOpen]=useState(false),[keyName,setKeyName]=useState(''),[newKey,setNewKey]=useState('');
  const active=apps.find(app=>app.id===current);
  const canManage=permissions.includes('application:manage'),canCredential=permissions.includes('application:credential:manage');
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    setLoading(true);setError('');
    try{
      const [list,status,identity]=await Promise.all([jsonRequest('/api/applications',{signal}).then(value=>applicationListResponseSchema.parse(value)),jsonRequest('/api/gateway/onboarding',{signal}).then(value=>onboardingSchema.parse(value)),jsonRequest('/api/auth/me',{signal})]);
      const parsed=z.object({user:z.object({permissions:z.array(z.string()).optional()}).optional(),permissions:z.array(z.string()).optional()}).parse(identity);
      const allowed=parsed.user?.permissions??parsed.permissions??[];setPermissions(allowed);
      setApps(list.items);setCurrent(list.currentApplicationId??status.applicationId);setOnboarding(status);
      const selected=list.items.find(app=>app.id===(list.currentApplicationId??status.applicationId));
      if(selected)setForm({name:selected.name,owner:selected.owner??'',department:selected.department??'',environment:selected.environment??'development',dataClass:selected.dataClass??'internal',routes:(selected.modelRoutes??[]).join('\n')});
      if(allowed.includes('application:credential:manage'))setCredentials(credentialListResponseSchema.parse(await jsonRequest('/api/application-credentials',{signal})).items);
    }catch(error:unknown){if(!signal?.aborted)setError(error instanceof Error?error.message:'加载失败');}
    finally{if(!signal?.aborted)setLoading(false);}
  },[]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[refresh]);
  async function switchApplication(id:string){const app=apps.find(item=>item.id===id);if(!app)return;setSaving(true);try{await jsonRequest('/api/auth/scope',{method:'POST',headers:{'content-type':'application/json',...csrfHeaders()},body:JSON.stringify({tenantId:app.tenantId,applicationId:id})});window.location.reload();}catch(error:unknown){toast.error(error instanceof Error?error.message:'切换失败');}finally{setSaving(false);}}
  async function save(){if(!active)return;setSaving(true);try{const body=updateApplicationSchema.parse({id:active.id,expectedAuthVersion:active.authVersion??1,name:form.name,owner:form.owner,department:form.department,environment:form.environment,dataClass:form.dataClass,modelRoutes:form.routes.split(/[\n,，]/u).map(item=>item.trim()).filter(Boolean)});await jsonRequest('/api/applications',{method:'PATCH',headers:{'content-type':'application/json',...csrfHeaders()},body:JSON.stringify(body)});toast.success('应用配置已保存，授权版本已更新');await refresh();}catch(error:unknown){toast.error(error instanceof z.ZodError?'请检查应用名称与模型路由格式':error instanceof Error?error.message:'保存失败');}finally{setSaving(false);}}
  async function create(){setSaving(true);try{await jsonRequest('/api/applications',{method:'POST',headers:{'content-type':'application/json',...csrfHeaders()},body:JSON.stringify({code:createCode,name:createName})});setCreateOpen(false);setCreateCode('');setCreateName('');toast.success('应用已创建，请选择后完成接入配置');await refresh();}catch(error:unknown){toast.error(error instanceof Error?error.message:'创建失败');}finally{setSaving(false);}}
  async function issueKey(){setSaving(true);try{const result=createdApplicationCredentialResponseSchema.parse(await jsonRequest('/api/application-credentials',{method:'POST',headers:{'content-type':'application/json',...csrfHeaders()},body:JSON.stringify({name:keyName,permissions:['guard:use']})}));setNewKey(result.apiKey);setKeyName('');await refresh();}catch(error:unknown){toast.error(error instanceof Error?error.message:'签发失败');}finally{setSaving(false);}}
  async function revoke(id:string){setSaving(true);try{await jsonRequest('/api/application-credentials?id='+encodeURIComponent(id),{method:'DELETE',headers:csrfHeaders()});toast.success('凭据已撤销');await refresh();}catch(error:unknown){toast.error(error instanceof Error?error.message:'撤销失败');}finally{setSaving(false);}}
  const change=(key:keyof Form,value:string)=>setForm(previous=>({...previous,[key]:value}));
  return <div className="space-y-5">
    <PageHeader title="应用接入工作台" description="应用资料、访问凭据、签名策略与真实调用验证" actions={<><Button variant="outline" onClick={()=>void refresh()} disabled={loading}><RefreshCw className="size-4"/>刷新</Button>{canManage&&<Button onClick={()=>setCreateOpen(true)}><Plus className="size-4"/>新建应用</Button>}</>}/>
    {error&&<p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="当前应用" value={active?.name??'—'} icon={Building2} hint={active?.code??'请选择应用'}/><MetricCard label="授权版本" value={onboarding?.authVersion??'—'} icon={KeyRound} hint="配置变更后立即撤销旧请求授权"/><MetricCard label="策略运行代次" value={onboarding?.runtime?.generation??'—'} icon={Layers} hint={onboarding?.runtime?`${onboarding.runtime.nodeCount} 个近期确认节点`:'尚无运行快照'}/><MetricCard label="接入验证" value={onboarding?onboardingLabels[onboarding.state]:'待配置'} icon={CheckCircle2} tone={onboarding&&['VERIFIED','ENFORCING'].includes(onboarding.state)?'green':'amber'} hint="依据真实执行记录自动判断"/></div>
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-4"><Card><CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3"><CardTitle>应用资料与模型路由</CardTitle><Select value={current} onValueChange={id=>void switchApplication(id)} disabled={saving}><SelectTrigger className="w-56 max-w-full" aria-label="选择应用"><SelectValue placeholder="选择应用"/></SelectTrigger><SelectContent>{apps.filter(app=>app.status==='active').map(app=><SelectItem key={app.id} value={app.id}>{app.name}</SelectItem>)}</SelectContent></Select></CardHeader><CardContent className="min-w-0 space-y-4">
        <div className="grid gap-4 md:grid-cols-2">{([['name','应用名称'],['owner','负责人'],['department','归属部门']] as const).map(([key,label])=><div key={key} className="space-y-2"><Label htmlFor={'app-'+key}>{label}</Label><Input id={'app-'+key} value={form[key]} onChange={event=>change(key,event.target.value)} disabled={!canManage}/></div>)}
          <div className="space-y-2"><Label htmlFor="app-env">运行环境</Label><Select value={form.environment} onValueChange={value=>change('environment',value)} disabled={!canManage}><SelectTrigger id="app-env"><SelectValue/></SelectTrigger><SelectContent>{[['development','开发'],['test','测试'],['staging','预生产'],['production','生产']].map(([value,label])=><SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label htmlFor="app-data">数据等级</Label><Select value={form.dataClass} onValueChange={value=>change('dataClass',value)} disabled={!canManage}><SelectTrigger id="app-data"><SelectValue/></SelectTrigger><SelectContent>{[['public','公开'],['internal','内部'],['confidential','机密'],['restricted','严格受限']].map(([value,label])=><SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
        </div><div className="space-y-2"><Label htmlFor="app-routes">允许调用的模型路由</Label><Textarea id="app-routes" value={form.routes} onChange={event=>change('routes',event.target.value)} disabled={!canManage} placeholder="每行一个网关模型路由名称"/><p className="text-xs text-muted-foreground">仅允许调用已配置的路由，目标模型还须满足当前数据等级的访问边界。</p></div>
        {canManage&&<Button onClick={()=>void save()} disabled={saving||!active}><Save className="size-4"/>保存配置</Button>}
      </CardContent></Card>
      <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>应用访问凭据</CardTitle>{canCredential&&<Button size="sm" variant="outline" onClick={()=>{setNewKey('');setKeyOpen(true);}}><KeyRound className="size-4"/>签发凭据</Button>}</CardHeader><CardContent className="space-y-3">{!canCredential?<p className="text-sm text-muted-foreground">当前角色无凭据管理权限。</p>:!credentials.length?<p className="text-sm text-muted-foreground">尚未签发凭据。应用调用使用 Bearer 或 X-Guard-Api-Key。</p>:credentials.map(key=><div key={key.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><p className="text-sm font-medium">{key.name}</p><p className="mt-1 font-mono text-[11px] text-muted-foreground">{key.keyId}</p><p className="mt-1 text-xs text-muted-foreground">{key.lastUsedAt?'最近使用 '+key.lastUsedAt.replace('T',' ').slice(0,19)+' UTC':'尚未使用'}</p></div><Button size="sm" variant="outline" disabled={saving} onClick={()=>void revoke(key.id)}>撤销</Button></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>调用示例</CardTitle></CardHeader><CardContent><p className="mb-3 text-xs text-muted-foreground">POST /v1/chat/completions · 应用凭据放入 Authorization: Bearer 请求头</p><pre className="max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-4 text-xs leading-6 text-slate-200">{onboarding?.sample??'加载中…'}</pre></CardContent></Card></div>
      <div className="min-w-0 space-y-4"><PublicationStatus/><Card><CardHeader><CardTitle>接入检查</CardTitle></CardHeader><CardContent className="min-w-0 space-y-4">{onboarding?.checks.map(check=><div key={check.id} className="flex items-start gap-3">{check.passed?<CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600"/>:<Circle className="mt-0.5 size-4 shrink-0 text-slate-300"/>}<div className="min-w-0"><Link href={check.href} className="text-sm font-medium hover:text-primary">{check.name}</Link><p className="mt-1 break-all text-xs leading-5 text-muted-foreground">{check.detail}</p></div></div>)}</CardContent></Card>
        <Card><CardHeader><CardTitle>当前运行版本</CardTitle></CardHeader><CardContent className="space-y-3 text-xs">{onboarding?.runtime?<><Badge variant="outline">{onboarding.runtime.state}</Badge><p>代次 {onboarding.runtime.generation} · 已完成调用 {onboarding.runtime.requestCount}</p><p className="break-all font-mono text-muted-foreground">{onboarding.runtime.snapshotId}</p><p className="break-all font-mono text-[10px] text-muted-foreground">SHA-256 {onboarding.runtime.digest}</p></>:<p className="text-muted-foreground">完成策略发布并发起调用后生成运行快照。</p>}<Button asChild variant="outline" className="w-full"><Link href="/policy-releases">查看策略发布</Link></Button><Button asChild variant="outline" className="w-full"><Link href="/gateway-requests">查看执行记录</Link></Button></CardContent></Card>
      </div>
    </div>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>新建应用</DialogTitle><DialogDescription>创建后配置模型路由、签名策略与访问凭据。</DialogDescription></DialogHeader><Label htmlFor="create-code">应用编码</Label><Input id="create-code" value={createCode} onChange={event=>setCreateCode(event.target.value)} placeholder="小写字母开头，如 customer-service"/><Label htmlFor="create-name">应用名称</Label><Input id="create-name" value={createName} onChange={event=>setCreateName(event.target.value)}/><DialogFooter><Button onClick={()=>void create()} disabled={saving||!createCode||!createName}>创建应用</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={keyOpen} onOpenChange={open=>{setKeyOpen(open);if(!open)setNewKey('');}}><DialogContent><DialogHeader><DialogTitle>{newKey?'凭据已签发':'签发应用凭据'}</DialogTitle><DialogDescription>{newKey?'请保存本次生成的凭据，关闭后不再展示。':'凭据仅用于当前应用的网关调用。'}</DialogDescription></DialogHeader>{newKey?<><pre className="whitespace-pre-wrap break-all rounded-md bg-slate-100 p-3 text-xs">{newKey}</pre><Button variant="outline" onClick={()=>void navigator.clipboard.writeText(newKey).then(()=>toast.success('已复制凭据')).catch(()=>toast.error('复制失败，请手动保存'))}><Copy className="size-4"/>复制凭据</Button></>:<><Label htmlFor="key-name">凭据用途</Label><Input id="key-name" value={keyName} onChange={event=>setKeyName(event.target.value)} placeholder="例如：生产客服应用"/><DialogFooter><Button onClick={()=>void issueKey()} disabled={saving||keyName.trim().length<2}>签发凭据</Button></DialogFooter></>}</DialogContent></Dialog>
  </div>;
}
