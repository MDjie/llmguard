'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { usePermissions } from '@/hooks/use-permissions';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { exportDateRange, exportStatsResponseSchema, requestExportApprovalSchema, type ExportDateRange, type ExportHistoryQuery } from '@/contracts/http/history';
import { toast } from 'sonner';

type Approval = { id: string; status: string; requesterId: string; purpose: string; expiresAt: string; queryHash: string; exportQuery: ExportHistoryQuery | null };
const queryKey = (query: ExportHistoryQuery) => JSON.stringify([query.format, query.startDate, query.endDate, query.action, query.riskType]);
async function approvalRequest(method: string, body?: unknown, query = '') {
  const response = await fetch(`/api/export/approvals${query}`, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', ...csrfHeaders() } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.detail || payload.error || `审批请求失败 (${response.status})`);
  return payload.data;
}
export default function ExportPage() {
  const can = usePermissions();
  const [format, setFormat] = useState<ExportHistoryQuery['format']>('json');
  const [range, setRange] = useState<ExportDateRange>('30d');
  const [action, setAction] = useState<NonNullable<ExportHistoryQuery['action']> | 'all'>('all');
  const [dates, setDates] = useState<Pick<ExportHistoryQuery, 'startDate' | 'endDate'> | null>(null);
  const [purpose, setPurpose] = useState('');
  const [ownApprovals, setOwnApprovals] = useState<Approval[]>([]);
  const [pending, setPending] = useState<Approval[]>([]);
  const [stats, setStats] = useState<{ totalRecords: number; exportLimit: number; dateRange: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { setDates(exportDateRange(range)); }, [range]);
  const query = useMemo<ExportHistoryQuery>(() => ({ format, ...dates, ...(action !== 'all' ? { action } : {}) }), [format, dates, action]);
  const loadApprovals = useCallback(async () => {
    if (can('audit:export')) setOwnApprovals(await approvalRequest('GET', undefined, '?status=approved&mine=true'));
    if (can('audit:approve')) setPending(await approvalRequest('GET', undefined, '?status=pending'));
  }, [can]);
  // Permission hook returns a fresh predicate; depend on primitive permissions below.
  const canExport = can('audit:export'); const canApprove = can('audit:approve');
  useEffect(() => {
    if (!dates || !canExport) { setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError('');
    const params = new URLSearchParams(Object.entries(query).filter(([key]) => key !== 'format'));
    void fetch(`/api/export/stats?${params}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('统计加载失败，请刷新重试');
      const parsed = exportStatsResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('统计响应格式错误');
      setStats(parsed.data.data);
    }).catch(caught => { if (!controller.signal.aborted) { setStats(null); setError(caught instanceof Error ? caught.message : '统计失败'); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, dates, canExport, refresh]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([canExport ? approvalRequest('GET', undefined, '?status=approved&mine=true') : [], canApprove ? approvalRequest('GET', undefined, '?status=pending') : []]).then(([own, requests]) => { if (!cancelled) { setOwnApprovals(own); setPending(requests); } }).catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : '审批加载失败'); });
    return () => { cancelled = true; };
  }, [canExport, canApprove, refresh]);
  const approved = ownApprovals.find(item => item.exportQuery && queryKey(item.exportQuery) === queryKey(query));
  const perform = async (operation: () => Promise<void>) => { setBusy(true); try { await operation(); await loadApprovals(); } catch (caught) { toast.error(caught instanceof Error ? caught.message : '操作失败'); } finally { setBusy(false); } };
  const download = async () => {
    if (!approved) return;
    await perform(async () => {
      const response = await fetch(`/api/export?${new URLSearchParams(Object.entries(query))}`, { headers: { 'x-export-approval-id': approved.id }, cache: 'no-store' });
      if (!response.ok) { const problem = await response.json(); throw new Error(problem.detail || problem.error || `导出失败 (${response.status})`); }
      const type = response.headers.get('content-type') ?? '';
      if (!type.startsWith(format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/markdown')) throw new Error('导出响应格式错误');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? `detection_records.${format === 'markdown' ? 'md' : format}`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setOwnApprovals(items => items.filter(item => item.id !== approved.id)); toast.success('导出文件已下载');
    });
  };
  return <div className="space-y-5"><h1 className="text-3xl font-bold">导出报告</h1><p className="text-muted-foreground">导出脱敏审计摘要；统计与导出使用相同的 UTC 自然日边界。每次下载需独立审批。</p>{error && <p role="alert" className="text-red-600">{error}</p>}
    <Button variant="outline" disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新统计与审批</Button>
    {canExport && <div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle>导出配置</CardTitle></CardHeader><CardContent className="space-y-4">
      <Label>导出格式</Label><div className="flex flex-wrap gap-2">{(['json', 'csv', 'markdown'] as const).map(item => <Button key={item} variant={format === item ? 'default' : 'outline'} onClick={() => setFormat(item)}>{item.toUpperCase()}</Button>)}</div>
      <Label>时间范围</Label><Select value={range} onValueChange={value => { if (value !== range) { setDates(null); setRange(value as ExportDateRange); } }}><SelectTrigger aria-label="时间范围"><SelectValue /></SelectTrigger><SelectContent>{(['7d', '30d', '90d', 'all'] as const).map(item => <SelectItem key={item} value={item}>{item === 'all' ? '全部记录' : `最近 ${item.slice(0, -1)} 天`}</SelectItem>)}</SelectContent></Select>
      <Label>处理动作</Label><Select value={action} onValueChange={value => setAction(value as typeof action)}><SelectTrigger aria-label="处理动作"><SelectValue /></SelectTrigger><SelectContent>{Object.entries({ all: '全部动作', allow: '放行', warn: '警告', block: '拦截', mask: '脱敏', rewrite: '改写' }).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select>
      <Label htmlFor="export-purpose">导出用途（至少 10 字）</Label><Textarea id="export-purpose" value={purpose} onChange={event => setPurpose(event.target.value)} />
      <Button disabled={busy || loading || !dates || !stats?.totalRecords || stats.totalRecords > stats.exportLimit} onClick={() => void perform(async () => { const parsed = requestExportApprovalSchema.safeParse({ purpose, exportQuery: query }); if (!parsed.success) throw new Error('请填写 10 至 500 字的导出用途'); const item = await approvalRequest('POST', parsed.data); toast.success(`已提交申请 ${item.id}，请另一名审批人审核`); })}>申请导出审批</Button>
      <Button disabled={busy || loading || !approved || !stats?.totalRecords || stats.totalRecords > stats.exportLimit} onClick={() => void download()}>下载已批准的报告</Button>
      <p className="text-sm">{approved ? `审批 ${approved.id}；有效期至 ${approved.expiresAt}` : '当前查询尚无可用批准。申请后等待另一名审批人审核，再刷新。'} 修改筛选条件或格式后需重新申请。</p>
    </CardContent></Card><Card><CardHeader><CardTitle>数据统计</CardTitle><CardDescription>单次最多导出 1,000 条；超限须缩小范围</CardDescription></CardHeader><CardContent>{loading ? '正在加载…' : stats ? <><Badge>{stats.totalRecords} 条</Badge><p className="mt-3">{stats.dateRange}</p>{stats.totalRecords === 0 && <p>暂无可导出记录</p>}{stats.totalRecords > stats.exportLimit && <p role="alert">当前范围超过单次上限，请缩小时间或动作范围。</p>}</> : '统计不可用'}</CardContent></Card></div>}
    {canApprove && <Card><CardHeader><CardTitle>待审批申请</CardTitle><CardDescription>只能审批其他主体的申请；审批不改变其查询范围</CardDescription></CardHeader><CardContent className="space-y-4">{!pending.length && <p>暂无待审批申请</p>}{pending.map(item => <div key={item.id} className="rounded border p-3 space-y-2 break-all"><p>{item.purpose}</p><p className="text-xs">申请人 {item.requesterId} · 到期 {item.expiresAt}</p><pre className="whitespace-pre-wrap text-xs">{JSON.stringify(item.exportQuery ?? { legacyQueryHash: item.queryHash }, null, 2)}</pre><div className="flex gap-2">{(['approved', 'rejected'] as const).map(decision => <Button key={decision} variant="outline" disabled={busy} onClick={() => void perform(async () => { await approvalRequest('PATCH', { id: item.id, decision }); })}>{decision === 'approved' ? '批准' : '拒绝'}</Button>)}</div></div>)}</CardContent></Card>}
  </div>;
}
