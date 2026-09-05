'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Beaker, CheckCircle2, FileCheck2, Layers3, Loader2, Plus, RefreshCw, Rocket, RotateCcw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { DictionaryReleaseSetPanel } from '@/components/policy/dictionary-release-set-panel';
import { PromptInjectionCatalogPanel } from '@/components/content-safety/PromptInjectionCatalogPanel';

type DictionaryLayer = 'PLATFORM_REDLINE' | 'INDUSTRY' | 'TENANT' | 'APPLICATION' | 'INCIDENT';
type DictionaryState = 'draft' | 'reviewed' | 'shadow' | 'canary' | 'active' | 'deprecated' | 'rolled_back';
type ManagedAction = 'approve' | 'publish' | 'activate' | 'rollback';

interface Policy { id: string; name: string; version: number; }
interface ValidationStats {
  passed: boolean;
  checkedEntries: number;
  checkedVariants: number;
  conflictCount: number;
  conflicts: Array<{ code: string; entryRef: string; conflictingEntryRef?: string }>;
  checkedAt: string;
}
interface TestingStats {
  passed: boolean;
  positiveCases: number;
  positivePassed: number;
  negativeCases: number;
  negativePassed: number;
  failedCaseRefs: string[];
  testedAt: string;
}
interface DictionaryRelease {
  releaseSetId?: string | null;
  id: string;
  policyId: string;
  dictionaryId: string;
  version: string;
  layer: DictionaryLayer;
  state: DictionaryState;
  entryCount: number;
  statistics: { validation?: ValidationStats; testing?: TestingStats };
  submittedBy: string;
  approvedBy: string | null;
  contentHash: string;
  signingKeyId: string;
  rollbackAvailable: boolean;
  hitTrend: Array<{ day: string; hits: number }>;
  createdAt: string;
}

const stateLabels: Record<DictionaryState, string> = {
  draft: '草稿', reviewed: '已审批', shadow: '影子', canary: '灰度', active: '当前编译源',
  deprecated: '历史编译源', rolled_back: '已回滚',
};
const layerLabels: Record<DictionaryLayer, string> = {
  PLATFORM_REDLINE: '平台红线', INDUSTRY: '行业', TENANT: '租户', APPLICATION: '应用', INCIDENT: '事件临时',
};
const actionLabels: Record<ManagedAction, string> = {
  approve: '审批词典', publish: '发布词典', activate: '设为编译候选', rollback: '回滚编译候选',
};

const sampleEntries = JSON.stringify([{
  canonicalTerm: '示例高风险词',
  variants: ['示例高风险词', '示例变体'],
  riskType: 'sensitive_compliance',
  matchType: 'contains',
  caseSensitive: false,
  score: 0.9,
  severity: 'HIGH',
  mandatoryDeny: false,
  locale: 'zh-CN',
  direction: 'BOTH',
  industry: 'general',
  contexts: ['chat'],
  owner: 'security-team',
  evidenceRequirement: '经审核的正反例与来源依据',
  positiveExamples: ['该文本包含示例高风险词'],
  negativeExamples: ['这是普通业务咨询'],
}], null, 2);

async function readJson<T>(response: Response): Promise<T> {
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(String(payload.detail ?? payload.title ?? 'HTTP ' + response.status));
  return payload as T;
}

function Trend({ points }: { readonly points: DictionaryRelease['hitTrend'] }) {
  const maximum = Math.max(1, ...points.map((point) => point.hits));
  return <div className="flex h-8 items-end gap-1" title={points.map((point) => `${point.day}: ${point.hits}`).join('\n')}>{points.map((point) => <span key={point.day} className="w-2 rounded-t bg-blue-400" style={{ height: `${Math.max(3, Math.round(point.hits / maximum * 28))}px` }} />)}</div>;
}

function TestSummary({ release }: { readonly release: DictionaryRelease }) {
  const validation = release.statistics.validation;
  const testing = release.statistics.testing;
  return <div className="space-y-1 text-xs"><p className={validation?.passed ? 'text-emerald-700' : 'text-gray-500'}>校验：{validation ? `${validation.passed ? '通过' : '失败'} · ${validation.conflictCount} 冲突` : '未执行'}</p><p className={testing?.passed ? 'text-emerald-700' : 'text-gray-500'}>正反例：{testing ? `${testing.positivePassed}/${testing.positiveCases} · ${testing.negativePassed}/${testing.negativeCases}` : '未执行'}</p></div>;
}

export default function DictionariesPage() {
  const [releases, setReleases] = useState<DictionaryRelease[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [stateFilter, setStateFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [policyId, setPolicyId] = useState('');
  const [dictionaryId, setDictionaryId] = useState('content-safety-custom');
  const [version, setVersion] = useState('1.0.0');
  const [layer, setLayer] = useState<DictionaryLayer>('TENANT');
  const [entriesJson, setEntriesJson] = useState(sampleEntries);
  const [actionTarget, setActionTarget] = useState<DictionaryRelease | null>(null);
  const [action, setAction] = useState<ManagedAction | null>(null);
  const [reason, setReason] = useState('');
  const [publishMode, setPublishMode] = useState<'SHADOW' | 'CANARY'>('SHADOW');
  const [workingId, setWorkingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = stateFilter === 'ALL' ? '' : `?state=${encodeURIComponent(stateFilter)}`;
      const [dictionaryPayload, policyPayload] = await Promise.all([
        readJson<{ data: DictionaryRelease[] }>(await fetch('/api/policy-governance/dictionaries' + query, { cache: 'no-store' })),
        readJson<{ data: Policy[] }>(await fetch('/api/policies', { cache: 'no-store' })),
      ]);
      setReleases(dictionaryPayload.data);
      setPolicies(policyPayload.data);
      setPolicyId((current) => current || policyPayload.data[0]?.id || '');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '词典治理数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [stateFilter]);
  useEffect(() => { void load(); }, [load]);

  const policyNames = useMemo(() => new Map(policies.map((policy) => [policy.id, policy.name])), [policies]);

  const createDraft = async () => {
    setCreating(true);
    try {
      const entries: unknown = JSON.parse(entriesJson);
      await readJson(await fetch('/api/policy-governance/dictionaries', {
        method: 'POST', headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ policyId, dictionaryId: dictionaryId.trim(), version: version.trim(), layer, entries }),
      }));
      toast.success('词典草稿已创建并完成内容签名');
      setCreateOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '词典草稿创建失败');
    } finally {
      setCreating(false);
    }
  };

  const quickAction = async (release: DictionaryRelease, next: 'validate' | 'test') => {
    setWorkingId(release.id + ':' + next);
    try {
      await readJson(await fetch(`/api/policy-governance/dictionaries/${release.id}/${next}`, {
        method: 'POST', headers: csrfHeaders(),
      }));
      toast.success(next === 'validate' ? '词典校验完成' : '正反例测试完成');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '词典操作失败');
    } finally {
      setWorkingId(null);
    }
  };

  const openAction = (release: DictionaryRelease, next: ManagedAction) => {
    setActionTarget(release); setAction(next); setReason(''); setPublishMode('SHADOW');
  };

  const submitAction = async () => {
    if (!actionTarget || !action || reason.trim().length < 1) return;
    setWorkingId(actionTarget.id + ':' + action);
    try {
      await readJson(await fetch(`/api/policy-governance/dictionaries/${actionTarget.id}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify(action === 'publish' ? { mode: publishMode, reason: reason.trim() } : { reason: reason.trim() }),
      }));
      toast.success(action === 'activate' ? '词典版本已设为下一次签名策略包编译候选' : actionLabels[action] + '成功');
      setActionTarget(null); setAction(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '词典状态流转失败');
    } finally {
      setWorkingId(null);
    }
  };

  const actions = (release: DictionaryRelease) => release.releaseSetId ? <Badge variant="outline">集合分片：请使用上方整组操作</Badge> : <div className="flex flex-wrap gap-1.5">
    {release.state === 'draft' && <><Button size="sm" variant="outline" disabled={workingId !== null} onClick={() => void quickAction(release, 'validate')}><FileCheck2 className="h-3.5 w-3.5" />校验</Button><Button size="sm" variant="outline" disabled={workingId !== null} onClick={() => void quickAction(release, 'test')}><Beaker className="h-3.5 w-3.5" />测试</Button><Button size="sm" disabled={!release.statistics.validation?.passed || !release.statistics.testing?.passed || workingId !== null} onClick={() => openAction(release, 'approve')}><CheckCircle2 className="h-3.5 w-3.5" />审批</Button></>}
    {release.state === 'reviewed' && <Button size="sm" onClick={() => openAction(release, 'publish')}><Rocket className="h-3.5 w-3.5" />发布</Button>}
    {(['shadow', 'canary'] as DictionaryState[]).includes(release.state) && <Button size="sm" onClick={() => openAction(release, 'activate')}><ShieldCheck className="h-3.5 w-3.5" />设为候选</Button>}
    {release.state === 'active' && release.rollbackAvailable && <Button size="sm" variant="destructive" onClick={() => openAction(release, 'rollback')}><RotateCcw className="h-3.5 w-3.5" />回滚候选</Button>}
  </div>;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <DictionaryReleaseSetPanel onChanged={load} />
      <PromptInjectionCatalogPanel />
      <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Layers3 className="h-6 w-6 text-blue-600" /><h2 className="text-2xl font-semibold text-gray-900">敏感词典治理</h2></div><p className="mt-1 text-sm text-gray-500">分层词典、签名版本、正反例门禁、灰度验证与策略包候选治理</p></div><div className="flex gap-2"><Button variant="outline" size="icon" title="刷新" onClick={() => void load()}><RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /></Button><Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建草稿</Button></div></div>
      <Card><CardHeader className="pb-3"><CardTitle className="text-base">发布安全边界</CardTitle><CardDescription>平台红线或 mandatory deny 词典禁止提交人自批；审批后的候选仅在下一次签名策略包发布后影响实时流量。</CardDescription></CardHeader><CardContent className="flex flex-wrap items-center gap-3"><Select value={stateFilter} onValueChange={setStateFilter}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部状态</SelectItem>{Object.entries(stateLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><span className="text-sm text-gray-500">共 {releases.length} 个版本</span></CardContent></Card>

      <div className="grid gap-3 md:hidden">{releases.map((release) => <Card key={release.id}><CardHeader className="pb-3"><div className="flex items-start justify-between gap-2"><div><CardTitle className="text-base">{release.dictionaryId} · {release.version}</CardTitle><CardDescription>{policyNames.get(release.policyId) ?? release.policyId}</CardDescription></div><Badge variant="outline">{stateLabels[release.state]}</Badge></div></CardHeader><CardContent className="space-y-3"><div className="flex flex-wrap gap-2"><Badge>{layerLabels[release.layer]}</Badge><Badge variant="outline">{release.entryCount} 变体</Badge></div><TestSummary release={release} /><Trend points={release.hitTrend} />{actions(release)}</CardContent></Card>)}</div>
      <div className="hidden overflow-x-auto rounded-md border bg-white md:block"><Table><TableHeader><TableRow><TableHead>词典 / 策略</TableHead><TableHead>层级与状态</TableHead><TableHead>测试门禁</TableHead><TableHead>7 日命中</TableHead><TableHead>签名摘要</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{loading ? <TableRow><TableCell colSpan={6} className="h-40 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></TableCell></TableRow> : releases.length === 0 ? <TableRow><TableCell colSpan={6} className="h-40 text-center text-gray-500">暂无词典版本</TableCell></TableRow> : releases.map((release) => <TableRow key={release.id}><TableCell><p className="font-medium">{release.dictionaryId} · {release.version}</p><p className="mt-1 text-xs text-gray-500">{policyNames.get(release.policyId) ?? release.policyId} · {release.submittedBy}</p></TableCell><TableCell><Badge>{layerLabels[release.layer]}</Badge><Badge variant="outline" className="ml-1">{stateLabels[release.state]}</Badge></TableCell><TableCell><TestSummary release={release} />{release.statistics.validation && !release.statistics.validation.passed && <p className="mt-1 text-xs text-red-600">{release.statistics.validation.conflicts.slice(0, 2).map((item) => item.code + ':' + item.entryRef).join('；')}</p>}</TableCell><TableCell><Trend points={release.hitTrend} /></TableCell><TableCell><p className="max-w-44 truncate font-mono text-xs" title={release.contentHash}>{release.contentHash}</p><p className="mt-1 max-w-44 truncate text-xs text-gray-500">{release.signingKeyId}</p></TableCell><TableCell>{actions(release)}</TableCell></TableRow>)}</TableBody></Table></div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>新建词典草稿</DialogTitle><DialogDescription>每个条目必须提供正例、反例、责任人和证据要求；正则会经过安全语法校验。</DialogDescription></DialogHeader><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label>策略</Label><Select value={policyId} onValueChange={setPolicyId}><SelectTrigger><SelectValue placeholder="选择策略" /></SelectTrigger><SelectContent>{policies.map((policy) => <SelectItem key={policy.id} value={policy.id}>{policy.name} · v{policy.version}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label>层级</Label><Select value={layer} onValueChange={(value) => setLayer(value as DictionaryLayer)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(layerLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor="dictionary-id">词典 ID</Label><Input id="dictionary-id" value={dictionaryId} maxLength={128} onChange={(event) => setDictionaryId(event.target.value)} /></div><div className="space-y-1.5"><Label htmlFor="dictionary-version">版本</Label><Input id="dictionary-version" value={version} maxLength={64} onChange={(event) => setVersion(event.target.value)} /></div><div className="space-y-1.5 sm:col-span-2"><Label htmlFor="dictionary-entries">条目 JSON</Label><Textarea id="dictionary-entries" value={entriesJson} rows={18} className="font-mono text-xs" onChange={(event) => setEntriesJson(event.target.value)} /></div></div><DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button><Button disabled={creating || !policyId || !dictionaryId.trim() || !version.trim()} onClick={() => void createDraft()}>{creating && <Loader2 className="h-4 w-4 animate-spin" />}创建签名草稿</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={Boolean(actionTarget && action)} onOpenChange={(open) => { if (!open) { setActionTarget(null); setAction(null); } }}><DialogContent><DialogHeader><DialogTitle>{action ? actionLabels[action] : '词典操作'}</DialogTitle><DialogDescription>{actionTarget ? `${actionTarget.dictionaryId} · ${actionTarget.version} · ${stateLabels[actionTarget.state]}` : ''}</DialogDescription></DialogHeader><div className="space-y-4">{action === 'publish' && <div className="space-y-1.5"><Label>发布模式</Label><Select value={publishMode} onValueChange={(value) => setPublishMode(value as 'SHADOW' | 'CANARY')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SHADOW">SHADOW（推荐先观察）</SelectItem><SelectItem value="CANARY">CANARY（受控灰度）</SelectItem></SelectContent></Select></div>}<div className="space-y-1.5"><Label htmlFor="dictionary-action-reason">操作理由</Label><Textarea id="dictionary-action-reason" value={reason} maxLength={500} rows={4} onChange={(event) => setReason(event.target.value)} /></div></div><DialogFooter><Button variant="outline" onClick={() => { setActionTarget(null); setAction(null); }}>取消</Button><Button variant={action === 'rollback' ? 'destructive' : 'default'} disabled={workingId !== null || !reason.trim()} onClick={() => void submitAction()}>{workingId && <Loader2 className="h-4 w-4 animate-spin" />}确认执行</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
