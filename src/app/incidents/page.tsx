'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock3, Eye, Loader2, Plus, RefreshCw, ShieldAlert, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { EvidenceAccessPanel } from '@/components/incidents/evidence-access-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/console/page-header';
import { MetricCard } from '@/components/console/metric-card';
import { DetailPanel } from '@/components/console/detail-panel';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { cn } from '@/lib/utils';

const statuses = ['PENDING_REVIEW', 'IN_PROGRESS', 'FALSE_POSITIVE', 'BLOCKED', 'REMEDIATED', 'CLOSED'] as const;
type IncidentStatus = (typeof statuses)[number];
type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface IncidentTransition {
  id: string;
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus;
  actorId: string;
  assigneeId: string | null;
  note: string | null;
  version: number;
  createdAt: string;
}

interface Incident {
  id: string;
  incidentNumber: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  traceId: string | null;
  sessionId: string | null;
  riskType: string;
  eventAnalysis: string;
  attackTechnique: string;
  impact: string;
  answerEvidence: string;
  answerEvidenceDigest?: string;
  answerEvidenceBytes?: number;
  rawEvidenceAccess?: 'APPROVAL_REQUIRED';
  assigneeId: string | null;
  slaDueAt: string;
  resolution: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  slaBreached: boolean;
  transitions?: IncidentTransition[];
}

interface IncidentList {
  items: Incident[];
  total: number;
}

const statusLabel: Record<IncidentStatus, string> = {
  PENDING_REVIEW: '待研判',
  IN_PROGRESS: '处置中',
  FALSE_POSITIVE: '误报',
  BLOCKED: '已阻断',
  REMEDIATED: '已修复',
  CLOSED: '已关闭',
};

const statusClass: Record<IncidentStatus, string> = {
  PENDING_REVIEW: 'border-amber-200 bg-amber-50 text-amber-700',
  IN_PROGRESS: 'border-blue-200 bg-blue-50 text-blue-700',
  FALSE_POSITIVE: 'border-gray-200 bg-gray-50 text-gray-700',
  BLOCKED: 'border-red-200 bg-red-50 text-red-700',
  REMEDIATED: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  CLOSED: 'border-zinc-200 bg-zinc-100 text-zinc-700',
};

const severityClass: Record<IncidentSeverity, string> = {
  LOW: 'border-slate-200 bg-slate-50 text-slate-700',
  MEDIUM: 'border-yellow-200 bg-yellow-50 text-yellow-800',
  HIGH: 'border-orange-200 bg-orange-50 text-orange-800',
  CRITICAL: 'border-red-200 bg-red-50 text-red-800',
};

const allowedTransitions: Record<IncidentStatus, readonly IncidentStatus[]> = {
  PENDING_REVIEW: ['IN_PROGRESS', 'FALSE_POSITIVE', 'BLOCKED'],
  IN_PROGRESS: ['FALSE_POSITIVE', 'BLOCKED', 'REMEDIATED', 'CLOSED'],
  FALSE_POSITIVE: ['IN_PROGRESS', 'CLOSED'],
  BLOCKED: ['IN_PROGRESS', 'REMEDIATED', 'CLOSED'],
  REMEDIATED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

const initialCreateForm = {
  title: '',
  severity: 'HIGH' as IncidentSeverity,
  traceId: '',
  sessionId: '',
  riskType: '',
  eventAnalysis: '',
  attackTechnique: '',
  impact: '',
  answerEvidence: '',
  assigneeId: '',
  slaMinutes: '60',
};

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  const payload = body ? JSON.parse(body) as Record<string, unknown> : {};
  if (!response.ok) {
    throw new Error(String(payload.detail ?? payload.title ?? payload.error ?? 'HTTP ' + response.status));
  }
  return payload as T;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function slaText(incident: Incident): string {
  if (incident.status === 'CLOSED') return '已关闭';
  const minutes = Math.ceil((new Date(incident.slaDueAt).getTime() - Date.now()) / 60_000);
  if (minutes < 0) return '超时 ' + Math.abs(minutes) + ' 分钟';
  if (minutes < 60) return '剩余 ' + minutes + ' 分钟';
  return '剩余 ' + Math.ceil(minutes / 60) + ' 小时';
}

export default function IncidentsPage() {
  const [items, setItems] = useState<Incident[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('ALL');
  const [severity, setSeverity] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Incident | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [transitionStatus, setTransitionStatus] = useState<IncidentStatus | ''>('');
  const [transitionAssignee, setTransitionAssignee] = useState('');
  const [transitionNote, setTransitionNote] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(initialCreateForm);
  const [creating, setCreating] = useState(false);
  const pageSize = 20;

  const loadIncidents = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status !== 'ALL') query.set('status', status);
      if (severity !== 'ALL') query.set('severity', severity);
      const payload = await responseJson<IncidentList>(
        await fetch('/api/incidents?' + query, { cache: 'no-store' }),
      );
      setItems(payload.items);
      setTotal(payload.total);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '安全事件加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, severity, status]);

  useEffect(() => {
    void loadIncidents();
  }, [loadIncidents]);

  const loadDetail = useCallback(async (incidentId: string) => {
    setDetailLoading(true);
    try {
      const incident = await responseJson<Incident>(
        await fetch('/api/incidents/' + incidentId, { cache: 'no-store' }),
      );
      setSelected(incident);
      setTransitionStatus('');
      setTransitionAssignee(incident.assigneeId ?? '');
      setTransitionNote('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '事件详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const pageStats = useMemo(() => ({
    critical: items.filter((item) => item.severity === 'CRITICAL').length,
    overdue: items.filter((item) => item.slaBreached).length,
    active: items.filter((item) => !['FALSE_POSITIVE', 'CLOSED'].includes(item.status)).length,
  }), [items]);

  const submitTransition = async () => {
    if (!selected || !transitionStatus) return;
    setTransitioning(true);
    try {
      await responseJson<Incident>(await fetch('/api/incidents/' + selected.id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          expectedVersion: selected.version,
          toStatus: transitionStatus,
          ...(transitionAssignee.trim() ? { assigneeId: transitionAssignee.trim() } : {}),
          ...(transitionNote.trim() ? { note: transitionNote.trim() } : {}),
        }),
      }));
      toast.success('事件状态已更新');
      await Promise.all([loadDetail(selected.id), loadIncidents()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '状态更新失败');
    } finally {
      setTransitioning(false);
    }
  };

  const createIncident = async () => {
    setCreating(true);
    try {
      const incident = await responseJson<Incident>(await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          title: createForm.title,
          severity: createForm.severity,
          ...(createForm.traceId.trim() ? { traceId: createForm.traceId.trim() } : {}),
          ...(createForm.sessionId.trim() ? { sessionId: createForm.sessionId.trim() } : {}),
          riskType: createForm.riskType,
          eventAnalysis: createForm.eventAnalysis,
          attackTechnique: createForm.attackTechnique,
          impact: createForm.impact,
          answerEvidence: createForm.answerEvidence,
          ...(createForm.assigneeId.trim() ? { assigneeId: createForm.assigneeId.trim() } : {}),
          slaMinutes: Number(createForm.slaMinutes),
        }),
      }));
      setCreateOpen(false);
      setCreateForm(initialCreateForm);
      setPage(1);
      toast.success('事件 ' + incident.incidentNumber + ' 已创建');
      await loadIncidents();
      await loadDetail(incident.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '事件创建失败');
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const createLongFields = [
    ['eventAnalysis', '事件分析'],
    ['attackTechnique', '攻击技术'],
    ['impact', '影响范围'],
    ['answerEvidence', '回答与证据'],
  ] as const;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <PageHeader title="风险事件" description="集中研判、分派与追踪大模型安全风险事件" actions={<>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadIncidents()}><RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />刷新</Button>
        <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-4" />新建事件</Button>
      </>} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="事件总数" value={total} unit="条" hint="当前筛选条件" icon={ShieldAlert} />
        <MetricCard label="当前页处理中" value={pageStats.active} unit="条" hint="当前列表记录" icon={UserRound} />
        <MetricCard label="当前页严重事件" value={pageStats.critical} unit="条" hint="CRITICAL 级别" icon={AlertTriangle} tone="red" />
        <MetricCard label="当前页 SLA 超时" value={pageStats.overdue} unit="条" hint="超出处置时限" icon={Clock3} tone="amber" />
      </div>
      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-white px-3 py-3">
        <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="全部状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">全部状态</SelectItem>
            {statuses.map((item) => <SelectItem key={item} value={item}>{statusLabel[item]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={(value) => { setSeverity(value); setPage(1); }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="全部级别" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">全部级别</SelectItem>
            {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-gray-500">共 {total} 条</span>
      </div>

      <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-48">事件编号</TableHead>
              <TableHead>事件与风险</TableHead>
              <TableHead className="w-24">级别</TableHead>
              <TableHead className="w-28">状态</TableHead>
              <TableHead className="w-36">责任人</TableHead>
              <TableHead className="w-36">SLA</TableHead>
              <TableHead className="w-40">创建时间</TableHead>
              <TableHead className="w-16"><span className="sr-only">操作</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8} className="h-40 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-gray-400" /></TableCell></TableRow>
            ) : items.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="h-40 text-center text-gray-500">当前筛选条件下没有安全事件</TableCell></TableRow>
            ) : items.map((incident) => (
              <TableRow key={incident.id} data-state={selected?.id === incident.id ? 'selected' : undefined} className="cursor-pointer" onClick={() => void loadDetail(incident.id)}>
                <TableCell className="font-mono text-xs text-gray-700">{incident.incidentNumber}</TableCell>
                <TableCell>
                  <p className="max-w-xl truncate font-medium text-gray-900">{incident.title}</p>
                  <p className="mt-1 max-w-xl truncate text-xs text-gray-500">{incident.riskType}</p>
                </TableCell>
                <TableCell><Badge variant="outline" className={severityClass[incident.severity]}>{incident.severity}</Badge></TableCell>
                <TableCell><Badge variant="outline" className={statusClass[incident.status]}>{statusLabel[incident.status]}</Badge></TableCell>
                <TableCell className="text-sm text-gray-600">{incident.assigneeId ?? '未分派'}</TableCell>
                <TableCell><span className={cn('flex items-center gap-1 text-xs', incident.slaBreached ? 'font-medium text-red-600' : 'text-gray-600')}><Clock3 className="h-3.5 w-3.5" />{slaText(incident)}</span></TableCell>
                <TableCell className="text-xs text-gray-500">{formatDate(incident.createdAt)}</TableCell>
                <TableCell><Button variant="ghost" size="icon" aria-label="查看事件详情" title="查看详情" onClick={(event) => { event.stopPropagation(); void loadDetail(incident.id); }}><Eye className="h-4 w-4" /></Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>上一页</Button>
        <span className="min-w-24 text-center text-sm text-gray-500">{page} / {totalPages}</span>
        <Button variant="outline" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}>下一页</Button>
      </div>

        </div>
        <DetailPanel title="事件详情" open={Boolean(selected) || detailLoading} onClose={() => setSelected(null)}>
          {detailLoading && !selected ? (
            <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          ) : selected ? (
            <>
              <div className="border-b border-border px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={severityClass[selected.severity]}>{selected.severity}</Badge>
                  <Badge variant="outline" className={statusClass[selected.status]}>{statusLabel[selected.status]}</Badge>
                  {selected.slaBreached && <Badge variant="destructive">SLA 超时</Badge>}
                </div>
                <h2 className="mt-3 text-base font-semibold">{selected.title}</h2>
                <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{selected.incidentNumber}</p>
              </div>
              <div className="space-y-5 px-4 py-4">
                <div className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
                  <div><p className="text-xs text-gray-500">风险类型</p><p className="mt-1 break-words">{selected.riskType}</p></div>
                  <div><p className="text-xs text-gray-500">责任人</p><p className="mt-1">{selected.assigneeId ?? '未分派'}</p></div>
                  <div><p className="text-xs text-gray-500">Trace ID</p><p className="mt-1 break-all font-mono text-xs">{selected.traceId ?? '-'}</p></div>
                  <div><p className="text-xs text-gray-500">Session ID</p><p className="mt-1 break-all font-mono text-xs">{selected.sessionId ?? '-'}</p></div>
                  <div><p className="text-xs text-gray-500">创建时间</p><p className="mt-1">{formatDate(selected.createdAt)}</p></div>
                  <div><p className="text-xs text-gray-500">SLA 截止</p><p className="mt-1">{formatDate(selected.slaDueAt)}</p></div>
                </div>
                {[
                  ['事件分析', selected.eventAnalysis],
                  ['攻击技术', selected.attackTechnique],
                  ['影响范围', selected.impact],
                  ['回答与证据', selected.answerEvidence],
                  ...(selected.resolution ? [['处置结论', selected.resolution]] : []),
                ].map(([label, value]) => (
                  <section key={label}>
                    <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
                    <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-gray-50 p-3 text-sm leading-6 text-gray-700">{value}</p>
                  </section>
                ))}
                <EvidenceAccessPanel incidentId={selected.id} sourceDigest={selected.answerEvidenceDigest} />
                {allowedTransitions[selected.status].length > 0 && (
                  <section className="border-y border-gray-200 py-5">
                    <h3 className="text-sm font-semibold text-gray-900">处置流转</h3>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label>目标状态</Label>
                        <Select value={transitionStatus} onValueChange={(value) => setTransitionStatus(value as IncidentStatus)}>
                          <SelectTrigger><SelectValue placeholder="选择目标状态" /></SelectTrigger>
                          <SelectContent>{allowedTransitions[selected.status].map((item) => <SelectItem key={item} value={item}>{statusLabel[item]}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="transition-assignee">责任人</Label>
                        <Input id="transition-assignee" value={transitionAssignee} maxLength={100} onChange={(event) => setTransitionAssignee(event.target.value)} />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="transition-note">处置说明</Label>
                        <Textarea id="transition-note" value={transitionNote} maxLength={4000} rows={4} onChange={(event) => setTransitionNote(event.target.value)} />
                      </div>
                    </div>
                    <Button className="mt-3" disabled={!transitionStatus || transitioning} onClick={() => void submitTransition()}>
                      {transitioning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}提交处置
                    </Button>
                  </section>
                )}
                <section>
                  <h3 className="text-sm font-semibold text-gray-900">流转记录</h3>
                  <div className="mt-3 space-y-0">
                    {(selected.transitions ?? []).map((transition, index) => (
                      <div key={transition.id} className="relative flex gap-3 pb-5">
                        {index < (selected.transitions?.length ?? 0) - 1 && <span className="absolute left-2 top-5 h-full w-px bg-gray-200" />}
                        <span className="relative mt-1.5 h-4 w-4 shrink-0 rounded-full border-4 border-white bg-blue-500 shadow-sm" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{statusLabel[transition.toStatus]}</span>
                            <span className="text-xs text-gray-400">v{transition.version}</span>
                            <span className="ml-auto text-xs text-gray-500">{formatDate(transition.createdAt)}</span>
                          </div>
                          <p className="mt-1 flex items-center gap-1 text-xs text-gray-500"><UserRound className="h-3 w-3" />{transition.actorId}{transition.assigneeId ? ' · 分派给 ' + transition.assigneeId : ''}</p>
                          {transition.note && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{transition.note}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </DetailPanel>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>新建安全事件</DialogTitle>
            <DialogDescription>事件创建后进入待研判状态并开始计算 SLA。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="incident-title">标题</Label>
              <Input id="incident-title" value={createForm.title} maxLength={200} onChange={(event) => setCreateForm((value) => ({ ...value, title: event.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>风险级别</Label>
              <Select value={createForm.severity} onValueChange={(value) => setCreateForm((current) => ({ ...current, severity: value as IncidentSeverity }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="incident-risk">风险类型</Label>
              <Input id="incident-risk" value={createForm.riskType} maxLength={128} onChange={(event) => setCreateForm((value) => ({ ...value, riskType: event.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="incident-trace">Trace ID</Label>
              <Input id="incident-trace" value={createForm.traceId} maxLength={128} onChange={(event) => setCreateForm((value) => ({ ...value, traceId: event.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="incident-session">Session ID</Label>
              <Input id="incident-session" value={createForm.sessionId} maxLength={128} onChange={(event) => setCreateForm((value) => ({ ...value, sessionId: event.target.value }))} />
            </div>
            {createLongFields.map(([field, label]) => (
              <div key={field} className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={'incident-' + field}>{label}</Label>
                <Textarea id={'incident-' + field} rows={3} maxLength={4000} value={createForm[field]} onChange={(event) => setCreateForm((value) => ({ ...value, [field]: event.target.value }))} />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="incident-assignee">责任人</Label>
              <Input id="incident-assignee" value={createForm.assigneeId} maxLength={100} onChange={(event) => setCreateForm((value) => ({ ...value, assigneeId: event.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="incident-sla">SLA（分钟）</Label>
              <Input id="incident-sla" type="number" min={5} max={129600} value={createForm.slaMinutes} onChange={(event) => setCreateForm((value) => ({ ...value, slaMinutes: event.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button disabled={creating} onClick={() => void createIncident()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}创建事件
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
