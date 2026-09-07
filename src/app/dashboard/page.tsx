'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, BarChart3, Clock3, FileCheck2, LockKeyhole, ShieldCheck, ShieldAlert, RefreshCw, ArrowRight, AlertCircle } from 'lucide-react';
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/components/console/page-header';
import { MetricCard } from '@/components/console/metric-card';
import { EmptyState } from '@/components/console/empty-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DIMENSION_LABELS } from '@/lib/dimension-labels';
import { cn } from '@/lib/utils';

interface StatsData {
  totalDetections: number;
  todayDetections: number;
  actionDistribution: { allow: number; warn: number; block: number; mask: number; rewrite: number };
  riskDistribution: Record<string, number>;
  avgScore: number | null;
  avgLatency: number | null;
  blockRate: string;
  trend: Array<{ date: string; count: number; blockCount: number; warnCount: number; maskCount: number }>;
}
interface InterceptionItem {
  id: string;
  inputText: string | null;
  inputScore: number | null;
  outputScore: number | null;
  createdAt: string;
  policyName?: string | null;
  findings: Array<{ dimension: string; dimensionName?: string }>;
}
const colors = ['#0862ff', '#17b8ac', '#f5a623', '#9464ed', '#49c6ee', '#fa7272'];
const numberFormat = new Intl.NumberFormat('zh-CN');
const dimensionLabels: Record<string, string> = { ...DIMENSION_LABELS };
const tooltipStyle = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--foreground)' };
const actions = [
  { key: 'allow', label: '放行', color: '#17b8ac' },
  { key: 'block', label: '拦截', color: '#ef5350' },
  { key: 'warn', label: '警告', color: '#f5a623' },
  { key: 'mask', label: '脱敏', color: '#0862ff' },
  { key: 'rewrite', label: '改写', color: '#9464ed' },
] as const;

export default function DashboardPage() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [interceptions, setInterceptions] = useState<InterceptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(false);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setHistoryError(false);
    try {
      const [statsRes, historyRes] = await Promise.all([
        fetch('/api/stats', { signal, cache: 'no-store' }),
        fetch('/api/history?action=block&limit=10', { signal, cache: 'no-store' }),
      ]);
      const result = await statsRes.json() as { success?: boolean; data?: StatsData; error?: string };
      if (!statsRes.ok || !result.success || !result.data) throw new Error(result.error || '统计数据暂时不可用');
      setStats(result.data);
      if (historyRes.ok) {
        const history = await historyRes.json() as { success?: boolean; data?: { sessions?: InterceptionItem[] } };
        setHistoryError(!history.success);
        setInterceptions(history.success ? history.data?.sessions ?? [] : []);
      } else { setHistoryError(true); setInterceptions([]); }
    } catch (err: unknown) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : '加载数据失败');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const riskData = Object.entries(stats?.riskDistribution ?? {}).filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a).map(([key, value]) => ({ name: dimensionLabels[key] || key, value }));
  const riskTotal = riskData.reduce((sum, item) => sum + item.value, 0);
  const totalActions = stats ? Object.values(stats.actionDistribution).reduce((sum, count) => sum + count, 0) : 0;
  const num = (value: number) => numberFormat.format(value);

  return (
    <div className="space-y-4" aria-busy={loading}>
      <PageHeader title="总览大屏" description="大模型安全运行态势总览" actions={
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void fetchData()}><RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />刷新数据</Button>
      } />
      {error && <div role="alert" className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="size-4 shrink-0" />{error}，请重试刷新。{stats && '下方保留上次成功加载的数据。'}</div>}
      {!stats && loading ? <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28 rounded-md" />)}</div> : stats && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <MetricCard label="累计检测请求" value={num(stats.totalDetections)} unit="次" hint="当前应用 · 全部记录" icon={ShieldCheck} />
          <MetricCard label="今日检测请求" value={num(stats.todayDetections)} unit="次" hint="按服务端自然日统计" icon={BarChart3} />
          <MetricCard label="风险拦截次数" value={num(stats.actionDistribution.block)} unit="次" hint={<>累计拦截率 <span className="font-medium text-red-500">{stats.blockRate}</span></>} icon={ShieldAlert} />
          <MetricCard label="敏感内容脱敏" value={num(stats.actionDistribution.mask)} unit="次" hint="累计脱敏处置记录" icon={LockKeyhole} />
          <MetricCard label="风险警告次数" value={num(stats.actionDistribution.warn)} unit="次" hint="累计警告处置记录" icon={FileCheck2} />
          <MetricCard label="平均检测耗时" value={stats.avgLatency !== null ? num(Math.round(stats.avgLatency)) : '—'} unit="ms" hint="检测记录平均耗时" icon={Clock3} />
        </div>

        <div className="grid gap-3 xl:grid-cols-12">
          <Card className="min-w-0 xl:col-span-5">
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle>检测请求趋势</CardTitle><span className="rounded border px-2 py-1 text-[10px] text-muted-foreground">近 7 天</span></CardHeader>
            <CardContent>
              <div className="mb-3 flex flex-wrap justify-end gap-4 text-[10px] text-muted-foreground">{[['总检测', '#0862ff'], ['拦截', '#ef5350'], ['警告', '#f5a623'], ['脱敏', '#17b8ac']].map(([label, color]) => <span key={label} className="flex items-center gap-1.5"><i className="size-1.5 rounded-full" style={{ background: color }} />{label}</span>)}</div>
              {stats.trend.length ? <div className="h-52"><ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats.trend} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                  <CartesianGrid stroke="#e9eef7" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5).replace('-', '/')} tick={{ fontSize: 10, fill: '#8490a9' }} axisLine={false} tickLine={false} dy={6} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#8490a9' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Line dataKey="count" name="总检测" stroke="#0862ff" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
                  <Line dataKey="blockCount" name="拦截" stroke="#ef5350" strokeWidth={1.5} dot={{ r: 2 }} isAnimationActive={false} />
                  <Line dataKey="warnCount" name="警告" stroke="#f5a623" strokeWidth={1.5} dot={{ r: 2 }} isAnimationActive={false} />
                  <Line dataKey="maskCount" name="脱敏" stroke="#17b8ac" strokeWidth={1.5} dot={{ r: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer></div> : <EmptyState />}
            </CardContent>
          </Card>
          <Card className="min-w-0 xl:col-span-4">
            <CardHeader><CardTitle>风险类型分布</CardTitle></CardHeader>
            <CardContent>
              {riskTotal ? <div className="flex min-h-60 flex-wrap items-center justify-center gap-2">
                <div className="relative h-44 w-40 shrink-0">
                  <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={riskData} dataKey="value" innerRadius={51} outerRadius={72} paddingAngle={1} stroke="#fff" isAnimationActive={false}>{riskData.map((entry, i) => <Cell key={entry.name} fill={colors[i % colors.length]} />)}</Pie><Tooltip contentStyle={tooltipStyle} /></PieChart></ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-xl font-semibold tabular-nums">{num(riskTotal)}</span><span className="mt-1 text-[10px] text-muted-foreground">风险命中项</span></div>
                </div>
                <div className="min-w-32 flex-1 space-y-3">{riskData.map((item, i) => <div key={item.name} className="flex items-center gap-2 text-[11px]"><i className="size-1.5 shrink-0 rounded-full" style={{ background: colors[i % colors.length] }} /><span className="truncate text-muted-foreground" title={item.name}>{item.name}</span><span className="ml-auto shrink-0 tabular-nums">{(100 * item.value / riskTotal).toFixed(1)}%</span></div>)}</div>
              </div> : <EmptyState title="暂无风险命中" description="风险命中记录将按类型汇总" />}
            </CardContent>
          </Card>
          <Card className="min-w-0 xl:col-span-3">
            <CardHeader><CardTitle>处置动作分布</CardTitle></CardHeader>
            <CardContent className="space-y-4 pt-2">
              {actions.map(({ key, label, color }) => {
                const count = stats.actionDistribution[key];
                const pct = totalActions ? count / totalActions * 100 : 0;
                return <div key={key}><div className="mb-2 flex justify-between text-[11px]"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{num(count)} <span className="ml-1 text-muted-foreground">{pct.toFixed(1)}%</span></span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} /></div></div>;
              })}
            </CardContent>
          </Card>
        </div>

        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_290px]">
          <Card className="min-w-0">
            <CardHeader className="flex flex-row items-center justify-between gap-3"><CardTitle>近期拦截记录</CardTitle><Button variant="link" size="sm" asChild><Link href="/history">查看全部<ArrowRight className="size-3" /></Link></Button></CardHeader>
            <CardContent>
              {historyError ? <EmptyState title="记录加载失败" description="请刷新重试，统计数据不受此状态影响" /> : !interceptions.length ? <EmptyState title="暂无拦截记录" description="被拦截的请求将在此展示" /> : <Table>
                <TableHeader><TableRow><TableHead>发生时间</TableHead><TableHead>检测内容摘要</TableHead><TableHead>风险类型</TableHead><TableHead>最高风险分</TableHead><TableHead>处置动作</TableHead></TableRow></TableHeader>
                <TableBody>{interceptions.map((item) => <TableRow key={item.id}>
                  <TableCell className="text-muted-foreground">{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</TableCell>
                  <TableCell className="max-w-52 truncate">{item.inputText || '原文未留存'}</TableCell>
                  <TableCell className="max-w-40 truncate">{item.findings?.map((f) => dimensionLabels[f.dimension] || f.dimensionName || f.dimension).join('、') || '—'}</TableCell>
                  <TableCell className="tabular-nums">{item.inputScore === null && item.outputScore === null ? '—' : Math.max(item.inputScore ?? 0, item.outputScore ?? 0)}</TableCell>
                  <TableCell><Badge variant="outline" className="border-red-100 bg-red-50 text-red-500">已拦截</Badge></TableCell>
                </TableRow>)}</TableBody>
              </Table>}
              <p className="mt-3 text-[11px] text-muted-foreground">当前应用最近 {interceptions.length} 条拦截记录</p>
            </CardContent>
          </Card>
          <div className="space-y-3">
            <Card><CardHeader><CardTitle>检测概况</CardTitle></CardHeader><CardContent className="space-y-4">
              <div className="flex items-center justify-between text-xs"><span className="flex items-center gap-2 text-muted-foreground"><Activity className="size-3.5 text-primary" />平均风险分</span><span className="font-semibold">{stats.avgScore?.toFixed(1) ?? '—'} <span className="font-normal text-muted-foreground">/ 100</span></span></div>
              <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">改写处置</span><span className="font-semibold">{num(stats.actionDistribution.rewrite)} 次</span></div>
              <div className="flex items-center justify-between text-xs"><span className="text-muted-foreground">风险类型</span><span className="font-semibold">{riskData.length} 类</span></div>
            </CardContent></Card>
            <Card><CardHeader><CardTitle>数据范围</CardTitle></CardHeader><CardContent className="space-y-2 text-xs leading-6 text-muted-foreground"><p>统计范围为当前应用；切换顶部应用后重新加载。</p><p>风险分布按命中项统计，同一请求可能命中多个类型。</p><p>页面展示检测记录中的处置结果，实际发送与释放效果需结合执行证据核验。</p></CardContent></Card>
          </div>
        </div>
      </>}
    </div>
  );
}
