'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Eye, FlaskConical, Loader2, Play, RefreshCw, RotateCw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { cn } from '@/lib/utils';

interface PolicyBundle {
  id: string;
  policyId: string;
  version: number;
  state: string;
  contentHash: string;
}

interface TestCase {
  id: string;
  title: string;
  category: string;
  expectedAction: string;
  severity: string;
  enabled: boolean;
}

interface EvaluationResult {
  id: string;
  testCaseId: string;
  expectedAction: string;
  actualAction: string;
  actualScore: number;
  latencyMs: number;
  isCorrect: boolean;
  decisionId: string;
}

interface EvaluationRun {
  id: string;
  bundleId: string | null;
  datasetHash: string | null;
  status: 'pending' | 'running' | 'retrying' | 'completed' | 'failed';
  totalCases: number;
  completedCases: number;
  accuracy: string | null;
  recall: string | null;
  falsePositiveRate: string | null;
  falseNegativeRate: string | null;
  f1Score: string | null;
  attempt: number;
  maxAttempts: number;
  failureHistory: Array<{ attempt: number; at: string; code: string; message: string }>;
  createdAt: string;
  completedAt: string | null;
  results?: EvaluationResult[];
}

const statusLabel: Record<EvaluationRun['status'], string> = {
  pending: '排队中',
  running: '运行中',
  retrying: '重试中',
  completed: '已完成',
  failed: '失败',
};

const statusClass: Record<EvaluationRun['status'], string> = {
  pending: 'border-gray-200 bg-gray-50 text-gray-700',
  running: 'border-blue-200 bg-blue-50 text-blue-700',
  retrying: 'border-amber-200 bg-amber-50 text-amber-700',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
};

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(String(payload.detail ?? payload.title ?? payload.error ?? 'HTTP ' + response.status));
  return payload as T;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function metric(value: string | null): string {
  return value === null ? '-' : Number(value).toFixed(2) + '%';
}

export default function EvaluationRunsPage() {
  const [bundles, setBundles] = useState<PolicyBundle[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [bundleId, setBundleId] = useState('');
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [category, setCategory] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [detail, setDetail] = useState<EvaluationRun | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [bundlePayload, casesPayload, runsPayload] = await Promise.all([
        readJson<{ success: boolean; data: PolicyBundle[] }>(await fetch('/api/policy-bundles', { cache: 'no-store' })),
        readJson<{ success: boolean; data: TestCase[] }>(await fetch('/api/test-cases', { cache: 'no-store' })),
        readJson<{ success: boolean; data: EvaluationRun[] }>(await fetch('/api/evaluation-runs?limit=100', { cache: 'no-store' })),
      ]);
      const selectableBundles = bundlePayload.data.filter((bundle) => !['retired', 'archived'].includes(bundle.state));
      const enabledCases = casesPayload.data.filter((testCase) => testCase.enabled !== false);
      setBundles(selectableBundles);
      setTestCases(enabledCases);
      setRuns(runsPayload.data);
      setBundleId((current) => current || selectableBundles[0]?.id || '');
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : '评测数据加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const hasActiveRuns = runs.some((run) => ['pending', 'running', 'retrying'].includes(run.status));
  useEffect(() => {
    if (!hasActiveRuns) return;
    const timer = window.setInterval(() => void loadData(true), 3_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRuns, loadData]);

  const categories = useMemo(
    () => [...new Set(testCases.map((testCase) => testCase.category))].sort(),
    [testCases],
  );
  const visibleCases = category === 'ALL'
    ? testCases
    : testCases.filter((testCase) => testCase.category === category);
  const bundleMap = useMemo(() => new Map(bundles.map((bundle) => [bundle.id, bundle])), [bundles]);

  const toggleCase = (id: string) => {
    setSelectedCases((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  };

  const selectVisible = () => {
    setSelectedCases((current) => [...new Set([...current, ...visibleCases.map((item) => item.id)])]);
  };

  const submitRun = async () => {
    if (!bundleId || selectedCases.length === 0) {
      toast.error('请选择策略包和至少一个测试用例');
      return;
    }
    const submissionKey = idempotencyKey || 'eval-' + crypto.randomUUID();
    if (!idempotencyKey) setIdempotencyKey(submissionKey);
    setSubmitting(true);
    try {
      const payload = await readJson<{ success: boolean; data: EvaluationRun; reused: boolean }>(
        await fetch('/api/evaluation-runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...csrfHeaders() },
          body: JSON.stringify({
            bundleId,
            testCaseIds: selectedCases,
            idempotencyKey: submissionKey,
            maxAttempts: 3,
          }),
        }),
      );
      toast.success(payload.reused ? '已复用相同评测作业' : '评测作业已进入队列');
      setIdempotencyKey('eval-' + crypto.randomUUID());
      await loadData(true);
      await loadDetail(payload.data.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '评测提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const loadDetail = async (runId: string) => {
    setDetailLoading(true);
    try {
      const payload = await readJson<{ success: boolean; data: EvaluationRun }>(
        await fetch('/api/evaluation-runs/' + runId, { cache: 'no-store' }),
      );
      setDetail(payload.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '评测详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const detailProgress = detail && detail.totalCases > 0
    ? Math.round(detail.completedCases / detail.totalCases * 100)
    : 0;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-emerald-600" />
            <h2 className="text-2xl font-semibold text-gray-900">评测门禁</h2>
          </div>
          <p className="mt-1 text-sm text-gray-500">对签名策略包执行可复算、可重试的异步回归评测</p>
        </div>
        <Button variant="outline" size="icon" title="刷新" onClick={() => void loadData()}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="space-y-4 rounded-md border border-gray-200 bg-white p-4">
          <div className="space-y-1.5">
            <Label>签名策略包</Label>
            <Select value={bundleId} onValueChange={setBundleId}>
              <SelectTrigger><SelectValue placeholder="选择策略包" /></SelectTrigger>
              <SelectContent>
                {bundles.map((bundle) => (
                  <SelectItem key={bundle.id} value={bundle.id}>
                    {bundle.policyId.slice(0, 8)} · v{bundle.version} · {bundle.state}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>样本分类</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部分类</SelectItem>
                {categories.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">已选 {selectedCases.length} / {testCases.length}</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={selectVisible}>选择当前</Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedCases([])}>清空</Button>
            </div>
          </div>
          <div className="max-h-[420px] space-y-1 overflow-y-auto border-y border-gray-100 py-2">
            {visibleCases.map((testCase) => (
              <label key={testCase.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 hover:bg-gray-50">
                <Checkbox checked={selectedCases.includes(testCase.id)} onCheckedChange={() => toggleCase(testCase.id)} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-800">{testCase.title}</span>
                  <span className="mt-0.5 block text-xs text-gray-500">{testCase.category} · 期望 {testCase.expectedAction}</span>
                </span>
              </label>
            ))}
          </div>
          <Button className="w-full" disabled={submitting || !bundleId || selectedCases.length === 0} onClick={() => void submitRun()}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            提交异步评测
          </Button>
          <p className="break-all font-mono text-[11px] text-gray-400">幂等键：{idempotencyKey || '提交时生成'}</p>
        </section>

        <section className="min-w-0 overflow-hidden rounded-md border border-gray-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>作业与策略包</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-40">进度</TableHead>
                <TableHead className="w-24">准确率</TableHead>
                <TableHead className="w-24">召回率</TableHead>
                <TableHead className="w-24">FPR</TableHead>
                <TableHead className="w-24">尝试</TableHead>
                <TableHead className="w-40">创建时间</TableHead>
                <TableHead className="w-16"><span className="sr-only">详情</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={9} className="h-40 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-gray-400" /></TableCell></TableRow>
              ) : runs.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="h-40 text-center text-gray-500">尚无评测作业</TableCell></TableRow>
              ) : runs.map((run) => {
                const progress = run.totalCases > 0 ? Math.round(run.completedCases / run.totalCases * 100) : 0;
                const bundle = run.bundleId ? bundleMap.get(run.bundleId) : undefined;
                return (
                  <TableRow key={run.id}>
                    <TableCell>
                      <p className="font-mono text-xs text-gray-800">{run.id}</p>
                      <p className="mt-1 text-xs text-gray-500">{bundle ? '包 v' + bundle.version + ' · ' + bundle.contentHash.slice(0, 12) : run.bundleId ?? '-'}</p>
                    </TableCell>
                    <TableCell><Badge variant="outline" className={statusClass[run.status]}>{statusLabel[run.status]}</Badge></TableCell>
                    <TableCell>
                      <div className="space-y-1"><Progress value={progress} /><span className="text-xs text-gray-500">{run.completedCases}/{run.totalCases}</span></div>
                    </TableCell>
                    <TableCell className="text-sm">{metric(run.accuracy)}</TableCell>
                    <TableCell className="text-sm">{metric(run.recall)}</TableCell>
                    <TableCell className="text-sm">{metric(run.falsePositiveRate)}</TableCell>
                    <TableCell className="text-sm">{run.attempt}/{run.maxAttempts}</TableCell>
                    <TableCell className="text-xs text-gray-500">{formatDate(run.createdAt)}</TableCell>
                    <TableCell><Button variant="ghost" size="icon" title="查看结果" onClick={() => void loadDetail(run.id)}><Eye className="h-4 w-4" /></Button></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </section>
      </div>

      <Sheet open={Boolean(detail) || detailLoading} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-3xl">
          {detailLoading && !detail ? (
            <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
          ) : detail ? (
            <>
              <SheetHeader className="border-b border-gray-200 px-6 py-5 text-left">
                <div><Badge variant="outline" className={statusClass[detail.status]}>{statusLabel[detail.status]}</Badge></div>
                <SheetTitle className="font-mono text-base">{detail.id}</SheetTitle>
                <SheetDescription className="break-all">数据集摘要 {detail.datasetHash ?? '-'}</SheetDescription>
              </SheetHeader>
              <div className="space-y-6 px-6 py-5">
                <div>
                  <div className="mb-2 flex justify-between text-sm"><span>执行进度</span><span>{detail.completedCases}/{detail.totalCases}</span></div>
                  <Progress value={detailProgress} />
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {[
                    ['准确率', metric(detail.accuracy)],
                    ['召回率', metric(detail.recall)],
                    ['F1', metric(detail.f1Score)],
                    ['误报率', metric(detail.falsePositiveRate)],
                    ['漏报率', metric(detail.falseNegativeRate)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md border border-gray-200 p-3 text-center">
                      <p className="text-xs text-gray-500">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p>
                    </div>
                  ))}
                </div>
                {detail.failureHistory.length > 0 && (
                  <section>
                    <h3 className="flex items-center gap-2 text-sm font-semibold"><RotateCw className="h-4 w-4 text-amber-600" />失败与重试</h3>
                    <div className="mt-2 space-y-2">
                      {detail.failureHistory.map((failure) => (
                        <div key={failure.at + failure.attempt} className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                          <p className="font-medium">第 {failure.attempt} 次 · {failure.code}</p>
                          <p className="mt-1 break-words">{failure.message}</p>
                          <p className="mt-1 text-xs text-amber-700">{formatDate(failure.at)}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                <section>
                  <h3 className="text-sm font-semibold">样本结果</h3>
                  <div className="mt-2 overflow-hidden rounded-md border border-gray-200">
                    <Table>
                      <TableHeader><TableRow><TableHead>样本</TableHead><TableHead>期望</TableHead><TableHead>实际</TableHead><TableHead>分数</TableHead><TableHead>时延</TableHead><TableHead>结果</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {(detail.results ?? []).map((result) => (
                          <TableRow key={result.id}>
                            <TableCell className="font-mono text-xs">{result.testCaseId}</TableCell>
                            <TableCell>{result.expectedAction}</TableCell>
                            <TableCell>{result.actualAction}</TableCell>
                            <TableCell>{result.actualScore}</TableCell>
                            <TableCell>{result.latencyMs} ms</TableCell>
                            <TableCell>{result.isCorrect ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-red-600" />}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
                <p className="text-xs text-gray-500">创建 {formatDate(detail.createdAt)} · 完成 {formatDate(detail.completedAt)} · 尝试 {detail.attempt}/{detail.maxAttempts}</p>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
