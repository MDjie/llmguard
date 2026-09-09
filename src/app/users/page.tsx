'use client';
import { useCallback,useEffect,useState,type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useAccessProfile } from '@/hooks/use-permissions';
import { iamFetch,roleLabels } from '@/lib/iam/client';
import { grantAttributesSchema,type GrantAttributes } from '@/lib/iam/policy';
import { GrantFields } from '@/components/iam/grant-fields';
import { toast } from 'sonner';

const userSchema=z.object({id:z.string(),username:z.string(),nickname:z.string().nullable(),role:z.string(),
  status:z.string(),tokenVersion:z.number(),defaultApplicationId:z.string().nullable(),
  identity:z.object({loginMethod:z.string(),issuer:z.string().nullable(),subject:z.string().nullable()}).nullable(),
  grants:z.array(z.object({applicationId:z.string(),status:z.string(),attributes:grantAttributesSchema,expiresAt:z.string().nullable()}))});
type User=z.infer<typeof userSchema>;
const listSchema=z.object({data:z.object({items:z.array(userSchema),total:z.number()})});
const appsSchema=z.object({items:z.array(z.object({id:z.string(),name:z.string(),environment:z.string(),dataClass:z.string(),authorizationAttributes:grantAttributesSchema}))});
const resultSchema=z.object({success:z.boolean(),approvalRequired:z.boolean().optional()});
const selectClass='h-10 w-full rounded-md border bg-background px-3 text-sm';
export default function UsersPage(){
  const {can,deploymentMode}=useAccessProfile();
  const implementationAdmin=deploymentMode==='implementation'&&can('iam:users:manage');
  const [rows,setRows]=useState<User[]>([]);
  const [apps,setApps]=useState<z.infer<typeof appsSchema>['items']>([]);
  const [total,setTotal]=useState(0),[page,setPage]=useState(1),[keyword,setKeyword]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[open,setOpen]=useState(false);
  const [editing,setEditing]=useState<User|null>(null);
  const [username,setUsername]=useState(''),[nickname,setNickname]=useState(''),[role,setRole]=useState('BUSINESS_OPERATOR');
  const [method,setMethod]=useState('local'),[issuer,setIssuer]=useState(''),[subject,setSubject]=useState('');
  const [password,setPassword]=useState(''),[reason,setReason]=useState(''),[status,setStatus]=useState('active');
  const [selected,setSelected]=useState<string[]>([]),[defaultApp,setDefaultApp]=useState(''),[expiry,setExpiry]=useState('');
  const [grantOverrides,setGrantOverrides]=useState<Record<string,GrantAttributes>>({});
  const reload=useCallback(async()=>{
    try{
      const [users,applications]=await Promise.all([
        iamFetch('/api/users?page='+page+'&keyword='+encodeURIComponent(keyword),listSchema),
        iamFetch('/api/applications',appsSchema)]);
      setRows(users.data.items);setTotal(users.data.total);setApps(applications.items);setError('');
    }catch(cause){setError(cause instanceof Error?cause.message:'加载失败');}
  },[page,keyword]);
  useEffect(()=>{if(can('iam:users:read'))void reload();},[can,reload]);
  function edit(user:User|null){
    setGrantOverrides(Object.fromEntries(user?.grants.map(grant=>[grant.applicationId,grant.attributes])??[]));
    setEditing(user);setUsername(user?.username??'');setNickname(user?.nickname??'');
    setRole(user?.role??'BUSINESS_OPERATOR');setStatus(user?.status??'active');
    setMethod(user?.identity?.loginMethod??'local');setIssuer(user?.identity?.issuer??'');setSubject(user?.identity?.subject??'');
    setPassword('');setReason('');setExpiry('');
    const ids=user?.grants.filter(grant=>grant.status==='active').map(grant=>grant.applicationId)??[];
    setSelected(ids);setDefaultApp(user?.defaultApplicationId??'');setOpen(true);
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);
    try{
      const grants=selected.map(applicationId=>{
        const existing=editing?.grants.find(grant=>grant.applicationId===applicationId);
        const app=apps.find(item=>item.id===applicationId);
        if(!app)throw new Error('选中的应用已不可用，请刷新');
        return {applicationId,attributes:grantOverrides[applicationId]??existing?.attributes??app.authorizationAttributes,
          expiresAt:expiry?new Date(expiry).toISOString():existing?.expiresAt??null};
      });
      const identity=method==='oidc'?{loginMethod:method,issuer,subject}:{loginMethod:method};
      const assignment={defaultApplicationId:defaultApp,grants};
      const base={nickname,role,assignment,reason};
      const body=editing?{...base,id:editing.id,expectedTokenVersion:editing.tokenVersion,
        ...(status!==editing.status?{status}:{}),
        ...(JSON.stringify(identity)!==JSON.stringify(editing.identity && (editing.identity.loginMethod==='oidc'?
          {loginMethod:'oidc',issuer:editing.identity.issuer,subject:editing.identity.subject}:{loginMethod:editing.identity.loginMethod}))?{identity}:{}),
        ...(password?{password}:{})}:{...base,username,identity,...(password?{password}:{})};
      const result=await iamFetch('/api/users',resultSchema,{method:editing?'PUT':'POST',body:JSON.stringify(body)});
      toast.success(result.approvalRequired?'已提交，请由独立审计管理员审批':'账户与授权已保存');
      setOpen(false);setPassword('');await reload();
    }catch(cause){toast.error(cause instanceof Error?cause.message:'保存失败');}finally{setBusy(false);}
  }
  return <div className="space-y-5 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">账户与授权</h1>
      <p className="mt-1 text-sm text-muted-foreground">{implementationAdmin?'实施测试模式：管理员开户和他人账户变更直接生效，仍需分配有效应用。':'按角色分工，显式分配应用。高权限账户的敏感变更需独立审批。'}</p></div>
      {can('iam:users:manage')&&<Button onClick={()=>edit(null)}>新建账户</Button>}</div>
    <Card><CardContent className="pt-6"><Input aria-label="搜索账户" placeholder="按用户名或姓名搜索" value={keyword} onChange={event=>{setKeyword(event.target.value);setPage(1);}}/>
      {error&&<p role="alert" className="mt-3 text-destructive">{error}</p>}
      <div className="overflow-x-auto"><table className="mt-4 w-full text-sm"><thead><tr className="border-b text-left">{['账户','角色','状态','登录方式','应用授权','操作'].map(text=><th key={text} className="p-3">{text}</th>)}</tr></thead>
        <tbody>{rows.map(user=><tr key={user.id} className="border-b"><td className="p-3">{user.nickname||user.username}<div className="text-xs text-muted-foreground">{user.username}</div></td>
          <td className="p-3">{roleLabels[user.role]??user.role}</td><td className="p-3"><Badge variant={user.status==='active'?'secondary':'outline'}>{user.status==='active'?'启用':user.status==='locked'?'锁定':'停用'}</Badge></td>
          <td className="p-3">{user.identity?.loginMethod==='oidc'?'企业登录':user.identity?.loginMethod==='emergency'?'应急账户':'本地密码'}</td>
          <td className="p-3">{user.grants.filter(grant=>grant.status==='active').length} 个</td><td className="p-3">{can('iam:users:manage')&&<Button variant="outline" size="sm" onClick={()=>edit(user)}>编辑授权</Button>}</td></tr>)}</tbody></table></div>
      {!rows.length&&!error&&<p className="p-6 text-center text-muted-foreground">暂无匹配账户</p>}
      <div className="mt-4 flex items-center justify-end gap-3"><span>共 {total} 个</span><Button variant="outline" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</Button><span>{page}</span><Button variant="outline" disabled={page*20>=total} onClick={()=>setPage(page+1)}>下一页</Button></div>
    </CardContent></Card>
    <Dialog open={open} onOpenChange={value=>{if(!busy){setOpen(value);if(!value)setPassword('');}}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{editing?'编辑账户与授权':'新建账户'}</DialogTitle><DialogDescription>应用、默认应用和身份资料一起保存。{implementationAdmin?'本次非应急变更直接生效。':'管理员敏感变更在审批通过后生效。'}初始密码请通过安全渠道交付。</DialogDescription></DialogHeader>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-4"><div><Label htmlFor="iam-username">用户名</Label><Input id="iam-username" required disabled={Boolean(editing)} value={username} onChange={e=>setUsername(e.target.value)}/></div>
          <div><Label htmlFor="iam-nickname">姓名</Label><Input id="iam-nickname" value={nickname} onChange={e=>setNickname(e.target.value)}/></div>
          <div><Label htmlFor="iam-role">角色</Label><select id="iam-role" className={selectClass} value={role} onChange={e=>setRole(e.target.value)}>{Object.entries(roleLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
          <div><Label htmlFor="iam-method">登录方式</Label><select id="iam-method" className={selectClass} value={method} onChange={e=>setMethod(e.target.value)}><option value="local">本地密码</option><option value="oidc">企业 OIDC</option><option value="emergency">应急账户（双人审批启用）</option></select></div></div>
        {editing&&<div><Label htmlFor="iam-status">账户状态</Label><select id="iam-status" className={selectClass} value={status} onChange={e=>setStatus(e.target.value)}><option value="active">启用</option><option value="disabled">停用</option><option value="locked">锁定</option></select></div>}
        {method==='oidc'?<div className="grid gap-3"><Label htmlFor="iam-issuer">企业身份签发地址（Issuer）</Label><Input id="iam-issuer" required type="url" value={issuer} onChange={e=>setIssuer(e.target.value)}/><Label htmlFor="iam-subject">企业账户标识（Subject）</Label><Input id="iam-subject" required value={subject} onChange={e=>setSubject(e.target.value)}/></div>:
          <div><Label htmlFor="iam-password">{editing?'重置密码（留空保留）':'初始密码'}</Label><Input id="iam-password" type="password" autoComplete="new-password" required={!editing} value={password} onChange={e=>setPassword(e.target.value)}/></div>}
        <fieldset className="space-y-2 rounded-md border p-3"><legend className="px-1 text-sm font-medium">授权应用</legend>
          {apps.map(app=><label key={app.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(app.id)} onChange={e=>setSelected(e.target.checked?[...selected,app.id]:selected.filter(id=>id!==app.id))}/>{app.name}<span className="text-muted-foreground">{app.environment} / {app.dataClass}</span></label>)}</fieldset>
        <div className="grid grid-cols-2 gap-4"><div><Label htmlFor="iam-default">默认应用</Label><select id="iam-default" className={selectClass} required value={defaultApp} onChange={e=>setDefaultApp(e.target.value)}><option value="">请选择</option>{apps.filter(app=>selected.includes(app.id)).map(app=><option value={app.id} key={app.id}>{app.name}</option>)}</select></div>
          <div><Label htmlFor="iam-expiry">统一授权到期时间（可选）</Label><Input id="iam-expiry" type="datetime-local" value={expiry} onChange={e=>setExpiry(e.target.value)}/></div></div>
        {apps.filter(app=>selected.includes(app.id)).map(app=><GrantFields key={app.id} id={app.id} name={app.name}
          value={grantOverrides[app.id]??app.authorizationAttributes} onChange={value=>setGrantOverrides(current=>({...current,[app.id]:value}))}/>)}
        <div><Label htmlFor="iam-reason">申请理由</Label><Textarea id="iam-reason" required minLength={5} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></div>
        <Button type="submit" disabled={busy||!selected.includes(defaultApp)}>{busy?'保存中…':'保存并提交'}</Button>
      </form>
    </DialogContent></Dialog>
    <Card><CardHeader><CardTitle>角色职责</CardTitle></CardHeader><CardContent className="grid gap-3 text-sm md:grid-cols-3">
      <p>系统管理员：账户、租户、应用与平台设置。</p><p>安全管理员：检测策略和安全运营，提交配置变更。</p><p>审计管理员：独立审批与审计导出。</p>
    </CardContent></Card>
  </div>;
}
