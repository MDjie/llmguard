'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, CheckCircle2, GitBranch, Loader2, Play, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { cn } from '@/lib/utils';

type BundleState = 'draft' | 'testing' | 'pending_approval' | 'approved' | 'shadow' | 'canary' | 'active' | 'retired' | 'archived';
type BundleAction = 'submit_test' | 'record_test_pass' | 'approve' | 'reject' | 'shadow' | 'canary' | 'activate' | 'rollback' | 'withdraw' | 'archive';

interface Policy {
  id: string;
  name: string;
  version: number;
  isActive: boolean;
}

interface PolicyBundle {
  id: string;
  policyId: string;
  version: number;
  state: BundleState;
  contentHash: string;
  signingKeyId: string;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  testedBy: string | null;
  testedAt: string | null;
  testEvidenceId: string | null;
  activatedAt: string | null;
  lifecycleVersion: number;
  createdAt: string;
}

interface EvaluationRun {
  id: string;
  bundleId: string | null;
  status: string;
  totalCases: number;
  completedCases: number;
  accuracy: string | null;
  recall: string | null;
  falsePositiveRate: string | null;
  falseNegativeRate: string | null;
}

const stateLabels: Record<BundleState, string> = {
  draft: '草稿',
  testing: '测试中',
  pending_approval: '待审批',
  approved: '已审批',
  shadow: '影子',
  canary: '灰度',
  active: '全量生效',
  retired: '已退役',
  archived: '已归档',
};

const stateClasses: Record<BundleState, string> = {
  draft: 'border-gray-200 bg-gray-50 text-gray-700',
  testing: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  pending_approval: 'border-amber-200 bg-amber-50 text-amber-700',
  approved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  shadow: 'border-violet-200 bg-violet-50 text-violet-700',
  canary: 'border-blue-200 bg-blue-50 text-blue-700',
  active: 'border-green-300 bg-green-50 text-green-800',
  retired: 'border-orange-200 bg-orange-50 text-orange-700',
  archived: 'border-zinc-200 bg-zinc-100 text-zinc-700',
};

const actionLabels: Record<BundleAction, string> = {
  submit_test: '提交测试',
  record_test_pass: '登记测试通过',
  approve: '审批通过',
  reject: '驳回',
  shadow: '进入影子',
  canary: '灰度发布',
  activate: '全量发布',
  rollback: '一键回滚',
  withdraw: '撤回',
  archive: '归档',
};

const actionsByState: Record<BundleState, readonly BundleAction[]> = {
  draft: ['submit_test'],
  testing: ['record_test_pass'],
  pending_approval: ['approve', 'reject'],
  approved: ['shadow'],
  shadow: ['canary', 'withdraw'],
  canary: ['canary', 'activate', 'withdraw'],
  active: ['rollback', 'withdraw'],
  retired: ['archive'],
  archived: [],
};

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    throw new Error(String(payload.detail ?? payload.title ?? payload.error ?? 'HTTP ' + response.status));
  }
  return payload as T;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

export default function PolicyReleasesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [bundles, setBundles] = useState<PolicyBundle[]>([]);
  const [evaluationRuns, setEvaluationRuns] = useState<EvaluationRun[]>([]);
  const [policyId, setPolicyId] = useState('ALL');
  const [compilePolicyId, setCompilePolicyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [selected, setSelected] = useState<PolicyBundle | null>(null);
  const [action, setAction] = useState<BundleAction | ''>('');
  const [evaluationRunId, setEvaluationRunId] = useState('');
  const [canaryPercent, setCanaryPercent] = useState('10');
  const [reason, setReason] = useState('');
  const [transitioning, setTransitioning] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [policyPayload, bundlePayload, evaluationPayload] = await Promise.all([
        readJson<{ success: boolean; data: Policy[] }>(await fetch('/api/policies', { cache: 'no-store' })),
        readJson<{ success: boolean; data: PolicyBundle[] }>(await fetch('/api/policy-bundles', { cache: 'no-store' })),
        readJson<{ success: boolean; data: EvaluationRun[] }>(await fetch('/api/evaluation-runs?limit=100', { cache: 'no-store' })),
      ]);
      setPolicies(policyPayload.data);
      setBundles(bundlePayload.data);
      setEvaluationRuns(evaluationPayload.data);
      setCompilePolicyId((current) => current || policyPayload.data.find((item) => item.isActive)?.id || policyPayload.data[0]?.id || '');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '策略发布数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const policyNames = useMemo(
    () => new Map(policies.map((policy) => [policy.id, policy.name])),
    [policies],
  );
  const filteredBundles = policyId === 'ALL'
    ? bundles
    : bundles.filter((bundle) => bundle.policyId === policyId);
  const eligibleRuns = selected
    ? evaluationRuns.filter((run) => run.bundleId === selected.id && run.status === 'completed')
    : [];

  const compileBundle = async () => {
    if (!compilePolicyId) return;
    setCompiling(true);
    try {
      await readJson(await fetch('/api/policy-bundles', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ policyId: compilePolicyId }),
      }));
      toast.success('已生成新的签名策略包草稿');
      await loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '策略包编译失败');
    } finally {
      setCompiling(false);
    }
  };

  const openTransition = (bundle: PolicyBundle, nextAction: BundleAction) => {
    setSelected(bundle);
    setAction(nextAction);
    setEvaluationRunId('');
    setCanaryPercent('10');
    setReason('');
  };

  const transitionBundle = async () => {
    if (!selected || !action) return;
    setTransitioning(true);
    try {
      await readJson(await fetch('/api/policy-bundles', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          bundleId: selected.id,
          action,
          expectedVersion: selected.lifecycleVersion,
          ...(action === 'canary' ? { canaryPercent: Number(canaryPercent) } : {}),
          ...(action === 'record_test_pass' ? { evaluationRunId } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      }));
      toast.success(actionLabels[action] + '成功');
      setSelected(null);
      setAction('');
      await loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '策略状态流转失败');
    } finally {
      setTransitioning(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <GitBranch className="h-6 w-6 text-blue-600" />
            <h2 className="text-2xl font-semibold text-gray-900">策略发布</h2>
          </div>
          <p className="mt-1 text-sm text-gray-500">签名策略包测试、审批、灰度、发布与回滚</p>
        </div>
        <Button variant="outline" size="icon" title="刷新" onClick={() => void loadData()}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-y border-gray-200 bg-white px-3 py-3">
        <div className="min-w-72 space-y-1.5">
          <Label>源策略</Label>
          <Select value={compilePolicyId} onValueChange={setCompilePolicyId}>
            <SelectTrigger><SelectValue placeholder="选择需要编译的策略" /></SelectTrigger>
            <SelectContent>
              {policies.map((policy) => <SelectItem key={policy.id} value={policy.id}>{policy.name} · v{policy.version}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button disabled={!compilePolicyId || compiling} onClick={() => void compileBundle()}>
          {compiling ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          编译签名包
        </Button>
        <div className="ml-auto min-w-56 space-y-1.5">
          <Label>列表范围</Label>
          <Select value={policyId} onValueChange={setPolicyId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">全部策略</SelectItem>
              {policies.map((policy) => <SelectItem key={policy.id} value={policy.id}>{policy.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>策略与版本</TableHead>
              <TableHead className="w-28">状态</TableHead>
              <TableHead className="w-28">生命周期</TableHead>
              <TableHead className="w-48">签名与摘要</TableHead>
              <TableHead className="w-40">测试证据</TableHead>
              <TableHead className="w-40">审批人</TableHead>
              <TableHead className="w-40">创建时间</TableHead>
              <TableHead className="w-72">可执行动作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8} className="h-40 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-gray-400" /></TableCell></TableRow>
            ) : filteredBundles.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="h-40 text-center text-gray-500">尚无签名策略包</TableCell></TableRow>
            ) : filteredBundles.map((bundle) => (
              <TableRow key={bundle.id}>
                <TableCell>
                  <p className="font-medium text-gray-900">{policyNames.get(bundle.policyId) ?? bundle.policyId}</p>
                  <p className="mt-1 text-xs text-gray-500">包版本 v{bundle.version} · 创建人 {bundle.createdBy}</p>
                </TableCell>
                <TableCell><Badge variant="outline" className={stateClasses[bundle.state]}>{stateLabels[bundle.state]}</Badge></TableCell>
                <TableCell className="font-mono text-xs">v{bundle.lifecycleVersion}</TableCell>
                <TableCell>
                  <p className="truncate font-mono text-xs" title={bundle.contentHash}>{bundle.contentHash.slice(0, 14)}...</p>
                  <p className="mt-1 truncate text-xs text-gray-500" title={bundle.signingKeyId}>{bundle.signingKeyId}</p>
                </TableCell>
                <TableCell className="text-xs">
                  {bundle.testEvidenceId ? (
                    <><p className="font-mono">{bundle.testEvidenceId.slice(0, 12)}...</p><p className="mt-1 text-gray-500">{formatDate(bundle.testedAt)}</p></>
                  ) : '-'}
                </TableCell>
                <TableCell className="text-xs">{bundle.approvedBy ? <><p>{bundle.approvedBy}</p><p className="mt-1 text-gray-500">{formatDate(bundle.approvedAt)}</p></> : '-'}</TableCell>
                <TableCell className="text-xs text-gray-500">{formatDate(bundle.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    {actionsByState[bundle.state].map((nextAction) => (
                      <Button
                        key={nextAction}
                        size="sm"
                        variant={nextAction === 'activate' ? 'default' : nextAction === 'rollback' ? 'destructive' : 'outline'}
                        onClick={() => openTransition(bundle, nextAction)}
                      >
                        {nextAction === 'rollback' ? <RotateCcw className="h-3.5 w-3.5" /> :
                          nextAction === 'archive' ? <Archive className="h-3.5 w-3.5" /> :
                          nextAction === 'activate' ? <Play className="h-3.5 w-3.5" /> :
                          <CheckCircle2 className="h-3.5 w-3.5" />}
                        {actionLabels[nextAction]}
                      </Button>
                    ))}
                    {actionsByState[bundle.state].length === 0 && <span className="text-xs text-gray-400">无后续动作</span>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={Boolean(selected && action)} onOpenChange={(open) => { if (!open) { setSelected(null); setAction(''); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{action ? actionLabels[action] : '策略流转'}</DialogTitle>
            <DialogDescription>
              {selected ? (policyNames.get(selected.policyId) ?? selected.policyId) + ' · 包版本 v' + selected.version + ' · 当前 ' + stateLabels[selected.state] : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {action === 'record_test_pass' && (
              <div className="space-y-1.5">
                <Label>合格评测证据</Label>
                <Select value={evaluationRunId} onValueChange={setEvaluationRunId}>
                  <SelectTrigger><SelectValue placeholder="选择已完成评测" /></SelectTrigger>
                  <SelectContent>
                    {eligibleRuns.map((run) => (
                      <SelectItem key={run.id} value={run.id}>
                        {run.id.slice(0, 8)} · {run.completedCases}/{run.totalCases} · 准确率 {run.accuracy ?? '-'}%
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {eligibleRuns.length === 0 && <p className="text-xs text-amber-700">该策略包暂无已完成评测，不能登记测试通过。</p>}
              </div>
            )}
            {action === 'canary' && (
              <div className="space-y-1.5">
                <Label htmlFor="canary-percent">灰度流量百分比</Label>
                <Input id="canary-percent" type="number" min={1} max={99} value={canaryPercent} onChange={(event) => setCanaryPercent(event.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="release-reason">变更理由</Label>
              <Textarea id="release-reason" rows={4} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSelected(null); setAction(''); }}>取消</Button>
            <Button
              disabled={transitioning || (action === 'record_test_pass' && !evaluationRunId)}
              onClick={() => void transitionBundle()}
            >
              {transitioning && <Loader2 className="h-4 w-4 animate-spin" />}
              确认执行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
