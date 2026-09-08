'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { z } from 'zod';
import { createWhitelistRuleSchema, whitelistDirections } from '@/contracts/http/whitelist';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePermissions } from '@/hooks/use-permissions';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { toast } from 'sonner';

type Draft = z.infer<typeof createWhitelistRuleSchema>;
type Rule = Omit<Draft, 'enabled'> & { id: string; enabled: boolean; revision: number; approvalStatus: string; proposedBy: string | null };
type Target = { id: string; name: string; dimension: string; policyId: string; mandatoryDeny: boolean };
const blankDraft = (): Draft => ({ name: '', description: '', policyScope: 'specific', policyIds: [], dimensionScope: 'specific', dimensionCodes: [], targetRuleIds: [], directions: ['INPUT'], expiresAt: '', priority: 100, pattern: '', matchType: 'contains', caseSensitive: false, enabled: false });
const localDate = (iso?: string) => { if (!iso) return ''; const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
async function request(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', ...csrfHeaders() } : method !== 'GET' ? csrfHeaders() : undefined, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok || !value.success) throw new Error(value.detail || value.error || `请求失败 (${response.status})`);
  return value;
}

export default function WhitelistPage() {
  const can = usePermissions();
  const [rules, setRules] = useState<Rule[]>([]);
  const [policies, setPolicies] = useState<Array<{ id: string; name: string }>>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testText, setTestText] = useState('');
  const [testPolicy, setTestPolicy] = useState('');
  const [testResult, setTestResult] = useState('');
  const load = useCallback(async () => {
    try {
      const [list, profiles] = await Promise.all([request('/api/whitelist-rules'), request('/api/policies')]);
      setRules(list.data); setPolicies(profiles.data); setError('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let cancelled = false;
    if (!open) return;
    setTargets([]);
    const ids = draft.policyScope === 'all' ? policies.map(item => item.id) : draft.policyIds;
    void Promise.all(ids.map(id => request(`/api/whitelist-rules/targets?policyId=${encodeURIComponent(id)}`))).then(values => {
      if (!cancelled) setTargets(values.flatMap(value => value.data));
    }).catch(caught => { if (!cancelled) setErrors({ targetRuleIds: caught instanceof Error ? caught.message : '目标加载失败' }); });
    return () => { cancelled = true; };
  }, [open, draft.policyIds, draft.policyScope, policies]);
  const begin = (rule?: Rule) => {
    setEditing(rule ?? null);
    setDraft(rule ? { name: rule.name, description: rule.description ?? '', policyScope: rule.policyScope, policyIds: rule.policyIds, dimensionScope: 'specific', dimensionCodes: rule.dimensionCodes, targetRuleIds: rule.targetRuleIds, directions: rule.directions, validFrom: localDate(rule.validFrom), expiresAt: localDate(rule.expiresAt), priority: rule.priority, pattern: rule.pattern, matchType: rule.matchType, caseSensitive: rule.caseSensitive, enabled: false } : { ...blankDraft(), expiresAt: localDate(new Date(Date.now() + 7 * 86400_000).toISOString()) });
    setErrors({}); setOpen(true);
  };
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try { await operation(); await load(); } catch (caught) { toast.error(caught instanceof Error ? caught.message : '操作失败'); } finally { setBusy(false); }
  };
  const save = async () => {
    const normalized = { ...draft, validFrom: draft.validFrom ? new Date(draft.validFrom).toISOString() : undefined, expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : '', enabled: false };
    const parsed = createWhitelistRuleSchema.safeParse(normalized);
    if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map(issue => [issue.path.join('.').split('.')[0], issue.message]))); return; }
    await perform(async () => { await request('/api/whitelist-rules', editing ? 'PUT' : 'POST', editing ? { ...parsed.data, id: editing.id, expectedRevision: editing.revision } : parsed.data); setOpen(false); toast.success('草稿已保存，等待独立审批'); });
  };
  const uniqueTargets = [...new Map(targets.map(target => [target.id, target])).values()];
  const fieldError = (field: string) => errors[field] ? <p role="alert" className="text-sm text-red-600">{errors[field]}</p> : null;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-3xl font-bold">白名单管理</h1><p className="text-sm text-muted-foreground">限定规则、方向与有效期的受控例外；不可豁免强制阻断规则。</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => void load()}>刷新</Button><Button disabled={!can('policy:manage')} onClick={() => begin()}>新增白名单</Button></div></div>
    <p className="text-sm">草稿经独立审批后才能编入策略。正式生效仍须通过 <Link className="underline" href="/policy-releases">策略发布与评测审批</Link>。</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {!error && rules.length === 0 && <p>暂无白名单规则</p>}
    {rules.map(rule => <Card key={rule.id}><CardHeader><CardTitle className="flex flex-wrap gap-2 break-words">{rule.name}<Badge variant="outline">{rule.approvalStatus === 'pending' ? '待审批' : rule.approvalStatus === 'approved' ? '已审批' : '已拒绝'}</Badge><Badge variant="secondary">版本 {rule.revision}</Badge></CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="break-words text-sm">{rule.description} · 目标 {rule.targetRuleIds.length} 条 · {rule.directions.join(' / ')} · 到期 {rule.expiresAt ? localDate(rule.expiresAt).replace('T', ' ') : '未设置'}</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || !can('policy:manage')} onClick={() => begin(rule)}>编辑草稿</Button><Button variant="outline" disabled={busy || !can('policy:manage')} onClick={() => { if (confirm(`确认删除白名单“${rule.name}”？已签名策略需重新发布才反映此变更。`)) void perform(() => request(`/api/whitelist-rules?id=${encodeURIComponent(rule.id)}`, 'DELETE')); }}>删除</Button>
      {rule.approvalStatus === 'pending' && <><Button disabled={busy || !can('policy:approve')} onClick={() => void perform(() => request('/api/whitelist-rules/approvals', 'PATCH', { id: rule.id, expectedRevision: rule.revision, decision: 'approved' }))}>独立审批通过</Button><Button variant="outline" disabled={busy || !can('policy:approve')} onClick={() => void perform(() => request('/api/whitelist-rules/approvals', 'PATCH', { id: rule.id, expectedRevision: rule.revision, decision: 'rejected' }))}>拒绝</Button></>}</div>
    </CardContent></Card>)}
    <Card><CardHeader><CardTitle>匹配预览</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">预览当前已审批规则的匹配情况；实际处置还取决于签名策略及方向，不作为生产生效证明。</p><Select value={testPolicy} onValueChange={setTestPolicy}><SelectTrigger aria-label="测试策略"><SelectValue placeholder="选择策略" /></SelectTrigger><SelectContent>{policies.map(policy => <SelectItem key={policy.id} value={policy.id}>{policy.name}</SelectItem>)}</SelectContent></Select><Textarea aria-label="测试文本" value={testText} onChange={event => setTestText(event.target.value)} /><Button disabled={busy || !testPolicy || !testText} onClick={() => void perform(async () => { const value = await request('/api/whitelist-rules/test', 'POST', { policyId: testPolicy, text: testText }); setTestResult(JSON.stringify(value.data ?? value, null, 2)); })}>测试匹配</Button>{testResult && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{testResult}</pre>}</CardContent></Card>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{editing ? '编辑白名单草稿' : '新增白名单'}</DialogTitle><DialogDescription>保存后禁用并重新进入审批。由另一名有审批权限的用户审核。</DialogDescription></DialogHeader>
      <div className="space-y-4"><div><Label htmlFor="whitelist-name">名称</Label><Input id="whitelist-name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />{fieldError('name')}</div>
      <div><Label htmlFor="whitelist-description">说明</Label><Textarea id="whitelist-description" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></div>
      <fieldset className="space-y-2"><legend>适用策略</legend>{draft.policyScope === 'all' && <p className="text-sm">旧规则覆盖当前应用全部策略，编辑时请选择明确策略。</p>}{policies.map(policy => <label key={policy.id} className="flex gap-2 items-center"><Checkbox checked={draft.policyIds.includes(policy.id)} onCheckedChange={checked => setDraft({ ...draft, policyScope: 'specific', policyIds: checked ? [...draft.policyIds, policy.id] : draft.policyIds.filter(id => id !== policy.id), targetRuleIds: [], dimensionCodes: [] })} />{policy.name}</label>)}{fieldError('policyIds')}</fieldset>
      <fieldset className="max-h-56 overflow-auto space-y-2"><legend>目标规则</legend>{uniqueTargets.map(target => <label key={target.id} className="flex items-start gap-2 text-sm"><Checkbox disabled={target.mandatoryDeny} checked={draft.targetRuleIds.includes(target.id)} onCheckedChange={checked => { const ids = checked ? [...draft.targetRuleIds, target.id] : draft.targetRuleIds.filter(id => id !== target.id); setDraft({ ...draft, targetRuleIds: ids, dimensionCodes: [...new Set(uniqueTargets.filter(item => ids.includes(item.id)).map(item => item.dimension))] }); }} /><span className="min-w-0 break-all">{target.name} · {target.dimension}{target.mandatoryDeny ? '（不可豁免）' : ''}</span></label>)}{!uniqueTargets.length && <p className="text-sm">请先选择有已启用检测规则的策略。</p>}{fieldError('targetRuleIds')}{fieldError('dimensionScope')}</fieldset>
      <fieldset className="flex flex-wrap gap-3"><legend>检测方向</legend>{whitelistDirections.map(direction => <label key={direction} className="flex items-center gap-2 text-xs"><Checkbox checked={draft.directions.includes(direction)} onCheckedChange={checked => setDraft({ ...draft, directions: checked ? [...draft.directions, direction] : draft.directions.filter(item => item !== direction) })} />{direction}</label>)}{fieldError('directions')}</fieldset>
      <div><Label htmlFor="whitelist-pattern">匹配内容</Label><Textarea id="whitelist-pattern" value={draft.pattern} onChange={event => setDraft({ ...draft, pattern: event.target.value })} />{fieldError('pattern')}</div>
      <Select value={draft.matchType} onValueChange={value => setDraft({ ...draft, matchType: value as Draft['matchType'] })}><SelectTrigger aria-label="匹配方式"><SelectValue /></SelectTrigger><SelectContent>{(['contains', 'exact', 'prefix', 'suffix', 'regex'] as const).map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select>
      <label className="flex gap-2"><Checkbox checked={draft.caseSensitive} onCheckedChange={checked => setDraft({ ...draft, caseSensitive: checked === true })} />区分大小写</label>
      <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="whitelist-start">生效时间（本地）</Label><Input id="whitelist-start" type="datetime-local" value={draft.validFrom ?? ''} onChange={event => setDraft({ ...draft, validFrom: event.target.value })} />{fieldError('validFrom')}</div><div><Label htmlFor="whitelist-expiry">到期时间（本地）</Label><Input id="whitelist-expiry" type="datetime-local" value={draft.expiresAt} onChange={event => setDraft({ ...draft, expiresAt: event.target.value })} />{fieldError('expiresAt')}</div></div>
      <Button disabled={busy || !can('policy:manage')} onClick={() => void save()}>保存待审批草稿</Button></div>
    </DialogContent></Dialog>
  </div>;
}
