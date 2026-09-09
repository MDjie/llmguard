'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MetricCard } from '@/components/console/metric-card';
import { DetailPanel } from '@/components/console/detail-panel';
import { EmptyState } from '@/components/console/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Trash2, Eye, RefreshCw, AlertCircle, AlertTriangle, CheckCircle2, CalendarIcon, X, Filter, Shield, Bot, GitMerge, type LucideIcon } from 'lucide-react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import JudgeModelResultCard from '@/components/judge/JudgeModelResultCard';
import { csrfHeaders } from '@/lib/auth/csrf-client';

interface Finding {
  dimension: string;
  dimensionName: string;
  score: number;
  severity: string;
  matchedRules: string[];
  evidence: string[];
  reason: string;
}

interface SkippedDimension {
  dimensionCode: string;
  dimensionName: string;
  whitelistId: string;
  whitelistName: string;
}

interface WhitelistMatched {
  id: string;
  name: string;
  policyScope: string;
  dimensionScope: string;
  effect: string;
}

// 裁判模型结果
interface JudgeModelResult {
  used: boolean;
  score?: number;
  confidence?: number;
  suggestedAction?: 'allow' | 'warn' | 'block';
  reason?: string;
  latencyMs?: number;
  error?: string;
}

// 决策追踪
interface DecisionTrace {
  ruleScore: number;
  ruleAction: 'allow' | 'warn' | 'block';
  judgeScore?: number;
  judgeAction?: 'allow' | 'warn' | 'block';
  decisionMode: string;
  finalScore: number;
  finalAction: 'allow' | 'warn' | 'block';
  reasoning: string;
}

interface Session {
  id: string;
  inputText: string | null;
  outputText: string | null;
  action: string;
  inputAction: string | null;
  outputAction: string | null;
  inputScore: number | null;
  outputScore: number | null;
  contentStored?: boolean;
  policyId?: string | null;
  policyName: string | null;
  direction: string;
  providerId?: string | null;
  providerName?: string | null;
  modelUsed: string | null;
  latencyMs: number | null;
  hasRisk: boolean;
  riskLevel: string;
  createdAt: string;
  findings: Finding[];
  whitelistMatched?: WhitelistMatched | null;
  skippedDimensions?: SkippedDimension[];
  // 裁判模型相关
  inputJudgeResult?: JudgeModelResult | null;
  inputDecisionTrace?: DecisionTrace | null;
  outputJudgeResult?: JudgeModelResult | null;
  outputDecisionTrace?: DecisionTrace | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function HistoryRecords() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({
    action: 'all',
    dimension: 'all',
    search: '',
    startDate: null as Date | null,
    endDate: null as Date | null,
  });
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [detailSession, setDetailSession] = useState<Session | null>(null);

  const fetchHistory = useCallback(async (page = 1) => {
    setLoading(true);
    setHistoryError(null);
    try {
      const params = new URLSearchParams();
      params.append('page', page.toString());
      params.append('limit', pagination.limit.toString());
      if (filter.action !== 'all') {
        params.append('action', filter.action);
      }
      if (filter.dimension !== 'all') {
        params.append('dimension', filter.dimension);
      }
      if (filter.search) {
        params.append('search', filter.search);
      }
      if (filter.startDate) {
        params.append('startDate', filter.startDate.toISOString());
      }
      if (filter.endDate) {
        params.append('endDate', filter.endDate.toISOString());
      }

      const res = await fetch(`/api/history?${params}`);
      const data = await res.json();

      if (res.ok && data.success && data.data) {
        setSessions(data.data.sessions || []);
        setPagination(data.data.pagination || { page: 1, limit: pagination.limit, total: 0, totalPages: 0 });
      } else { setHistoryError('检测记录加载失败，请刷新重试'); }
    } catch (error) {
      console.error('加载历史记录失败:', error);
      setHistoryError('检测记录加载失败，请刷新重试');
    } finally {
      setLoading(false);
    }
  }, [filter, pagination.limit]);

  useEffect(() => {
    void fetchHistory(1);
  }, [fetchHistory]);

  const clearFilters = () => {
    setFilter({
      action: 'all',
      dimension: 'all',
      search: '',
      startDate: null,
      endDate: null,
    });
  };

  const hasActiveFilters = filter.action !== 'all' || filter.dimension !== 'all' || filter.search || filter.startDate || filter.endDate;

  const deleteSession = async (id: string) => {
    try {
      const res = await fetch(`/api/history?id=${id}`, {
        method: 'DELETE',
        headers: { ...csrfHeaders() },
      });

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const text = await res.text();
      const data = text ? JSON.parse(text) : {};

      if (data.success) {
        fetchHistory(pagination.page);
        toast.success('删除成功');
      } else {
        toast.error(data.error || '删除失败');
      }
    } catch (error) {
      console.error('删除失败:', error);
      toast.error('删除失败');
    }
  };

  const getActionBadge = (action: string) => {
    const styles: Record<string, { icon: LucideIcon; text: string; tone: string }> = {
      block: { icon: AlertCircle, text: '拒绝', tone: 'border-red-100 bg-red-50 text-red-600' },
      warn: { icon: AlertTriangle, text: '警告', tone: 'border-amber-100 bg-amber-50 text-amber-600' },
      allow: { icon: CheckCircle2, text: '放行', tone: 'border-emerald-100 bg-emerald-50 text-emerald-600' },
      mask: { icon: Eye, text: '脱敏', tone: 'border-blue-100 bg-blue-50 text-blue-600' },
      rewrite: { icon: GitMerge, text: '改写', tone: 'border-violet-100 bg-violet-50 text-violet-600' },
      safe_response: { icon: Bot, text: '安全代答', tone: 'border-blue-100 bg-blue-50 text-blue-600' },
      require_review: { icon: AlertTriangle, text: '待审核', tone: 'border-amber-100 bg-amber-50 text-amber-600' },
    };
    const style = styles[action] ?? { icon: Shield, text: action || '未知动作', tone: 'border-slate-200 bg-slate-50 text-slate-600' };
    const Icon = style.icon;
    return <Badge variant="outline" className={cn('inline-flex items-center gap-1', style.tone)}><Icon className="size-3" />{style.text}</Badge>;
  };

  const getSeverityBadge = (severity: string) => {
    const colors: Record<string, string> = {
      critical: 'bg-red-100 text-red-800',
      high: 'bg-orange-100 text-orange-800',
      medium: 'bg-yellow-100 text-yellow-800',
      low: 'bg-green-100 text-green-800',
    };

    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[severity] || colors.low}`}>
        {severity.toUpperCase()}
      </span>
    );
  };

  // 生成页码列表
  const generatePageNumbers = (current: number, total: number): (number | string)[] => {
    const pages: (number | string)[] = [];

    if (total <= 7) {
      // 总页数 <= 7，显示所有页码
      for (let i = 1; i <= total; i++) {
        pages.push(i);
      }
    } else {
      // 总页数 > 7，显示部分页码
      if (current <= 3) {
        // 当前页在开头
        for (let i = 1; i <= 5; i++) pages.push(i);
        pages.push('...');
        pages.push(total);
      } else if (current >= total - 2) {
        // 当前页在末尾
        pages.push(1);
        pages.push('...');
        for (let i = total - 4; i <= total; i++) pages.push(i);
      } else {
        // 当前页在中间
        pages.push(1);
        pages.push('...');
        for (let i = current - 1; i <= current + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(total);
      }
    }

    return pages;
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">查看检测结论、处置动作和命中证据；完整内容版本请切换至“对话归档”。</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="匹配审计记录" value={pagination.total} unit="条" hint="当前筛选条件" icon={Shield} />
        <MetricCard label="当前页风险记录" value={sessions.filter((item) => item.hasRisk).length} unit="条" hint="当前列表记录" icon={AlertTriangle} tone="amber" />
        <MetricCard label="当前页脱敏处置" value={sessions.filter((item) => item.action === 'mask').length} unit="条" hint="当前列表记录" icon={Eye} />
        <MetricCard label="当前页拦截处置" value={sessions.filter((item) => item.action === 'block').length} unit="条" hint="当前列表记录" icon={AlertCircle} tone="red" />
      </div>
      {historyError && <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{historyError}</p>}
      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
      {/* 筛选栏 */}
      <Card>
        <CardContent className="pt-0">
          <div className="space-y-4">
            {/* 主筛选行 */}
            <div className="flex gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <Input
                  placeholder="搜索用户输入..."
                  value={filter.search}
                  onChange={(e) => setFilter({ ...filter, search: e.target.value })}
                />
              </div>
              <Select value={filter.action} onValueChange={(value) => setFilter({ ...filter, action: value })}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="处理动作" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部动作</SelectItem>
                  <SelectItem value="block">拒绝</SelectItem>
                  <SelectItem value="warn">警告</SelectItem>
                  <SelectItem value="allow">放行</SelectItem>
                  <SelectItem value="mask">脱敏</SelectItem>
                  <SelectItem value="rewrite">改写</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filter.dimension} onValueChange={(value) => setFilter({ ...filter, dimension: value })}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="风险维度" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部维度</SelectItem>
                  <SelectItem value="prompt_injection">提示词注入</SelectItem>
                  <SelectItem value="pii_leak">信息泄露</SelectItem>
                  <SelectItem value="malicious_code">恶意代码</SelectItem>
                  <SelectItem value="violence_hate">暴力仇恨</SelectItem>
                  <SelectItem value="illegal_content">非法内容</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                aria-label="时间筛选" aria-expanded={showFilters}
                onClick={() => setShowFilters(!showFilters)}
                className={cn(showFilters && "bg-accent")}
              >
                <Filter className="h-4 w-4" />
              </Button>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="h-4 w-4 mr-1" />
                  清除筛选
                </Button>
              )}
              <Button onClick={() => fetchHistory(1)}>
                <RefreshCw className="h-4 w-4 mr-2" />
                刷新
              </Button>
            </div>

            {/* 时间范围筛选 */}
            {showFilters && (
              <div className="flex gap-4 items-end flex-wrap pt-2 border-t">
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">开始时间</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className={cn(
                        "w-[200px] justify-start text-left font-normal",
                        !filter.startDate && "text-muted-foreground"
                      )}>
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {filter.startDate ? format(filter.startDate, "PPP", { locale: zhCN }) : "选择日期"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={filter.startDate || undefined}
                        onSelect={(date) => setFilter({ ...filter, startDate: date || null })}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm text-muted-foreground">结束时间</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className={cn(
                        "w-[200px] justify-start text-left font-normal",
                        !filter.endDate && "text-muted-foreground"
                      )}>
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {filter.endDate ? format(filter.endDate, "PPP", { locale: zhCN }) : "选择日期"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={filter.endDate || undefined}
                        onSelect={(date) => setFilter({ ...filter, endDate: date || null })}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                {(filter.startDate || filter.endDate) && (
                  <Button variant="ghost" size="sm" onClick={() => setFilter({ ...filter, startDate: null, endDate: null })}>
                    清除时间
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 记录列表 */}
      <Card>
        <CardHeader><CardTitle>内容审计记录</CardTitle></CardHeader>
        <CardContent>
          {loading ? <div className="py-16 text-center text-sm text-muted-foreground">加载中...</div> : sessions.length === 0 ? <EmptyState title={historyError ? '记录暂不可用' : '暂无检测记录'} description={historyError ? '请刷新重试' : '调整筛选条件或完成一次检测后查看'} /> : <Table>
            <TableHeader><TableRow><TableHead>发生时间</TableHead><TableHead>内容摘要</TableHead><TableHead>命中策略</TableHead><TableHead>处置动作</TableHead><TableHead>最高风险分</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
            <TableBody>{sessions.map((session) => <TableRow key={session.id} data-state={detailSession?.id === session.id ? 'selected' : undefined}>
              <TableCell className="text-muted-foreground">{new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false })}</TableCell>
              <TableCell className="max-w-52"><p className="truncate">{session.inputText ?? '原文未保留'}</p><p className="mt-1 truncate text-[10px] text-muted-foreground">{[session.providerName, session.modelUsed].filter(Boolean).join(' / ') || '—'}</p></TableCell>
              <TableCell className="max-w-36 truncate text-muted-foreground">{session.policyName || '—'}</TableCell>
              <TableCell>{getActionBadge(session.action)}</TableCell>
              <TableCell className="tabular-nums">{session.inputScore === null && session.outputScore === null ? '—' : Math.max(session.inputScore ?? 0, session.outputScore ?? 0)}</TableCell>
              <TableCell><div className="flex items-center"><Button variant="link" size="sm" onClick={() => setDetailSession(session)}>详情</Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="删除记录">
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>确认删除</AlertDialogTitle>
                        <AlertDialogDescription>
                          此操作无法撤销，确定要删除这条检测记录吗？
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => deleteSession(session.id)}>
                          删除
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
              </div></TableCell>
            </TableRow>)}</TableBody>
          </Table>}
          {/* 分页 */}
          {pagination.total > 0 && (
            <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-6 pt-4 border-t">
              {/* 左侧：每页条数选择 */}
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span>每页显示</span>
                <Select
                  value={pagination.limit.toString()}
                  onValueChange={(value) => {
                    const newLimit = parseInt(value);
                    setPagination(prev => ({ ...prev, limit: newLimit }));
                  }}
                >
                  <SelectTrigger className="w-20 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="20">20</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
                <span>条</span>
                <span className="ml-4">共 {pagination.total} 条记录</span>
              </div>

              {/* 右侧：分页控制 */}
              {pagination.totalPages > 1 && (
                <div className="flex items-center gap-1">
                  {/* 首页 */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchHistory(1)}
                    disabled={pagination.page === 1}
                    className="h-8 px-2"
                  >
                    首页
                  </Button>

                  {/* 上一页 */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchHistory(pagination.page - 1)}
                    disabled={pagination.page === 1}
                    className="h-8 px-2"
                  >
                    上一页
                  </Button>

                  {/* 页码 */}
                  <div className="hidden items-center gap-1 mx-2 sm:flex">
                    {generatePageNumbers(pagination.page, pagination.totalPages).map((pageNum, idx) => (
                      pageNum === '...' ? (
                        <span key={`ellipsis-${idx}`} className="px-2 text-gray-400">...</span>
                      ) : (
                        <Button
                          key={pageNum}
                          variant={pagination.page === pageNum ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => fetchHistory(pageNum as number)}
                          className="h-8 w-8 p-0"
                        >
                          {pageNum}
                        </Button>
                      )
                    ))}
                  </div>

                  {/* 下一页 */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchHistory(pagination.page + 1)}
                    disabled={pagination.page === pagination.totalPages}
                    className="h-8 px-2"
                  >
                    下一页
                  </Button>

                  {/* 末页 */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchHistory(pagination.totalPages)}
                    disabled={pagination.page === pagination.totalPages}
                    className="h-8 px-2"
                  >
                    末页
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
        </div>
        <DetailPanel title="审计详情" open={Boolean(detailSession)} onClose={() => setDetailSession(null)}>
          <div className="p-4">
            {detailSession && <div className="mb-3">{getActionBadge(detailSession.action)}</div>}
            <div className="text-left text-muted-foreground text-sm">
              {detailSession && (
                <div className="space-y-4 mt-2">
                  {/* 基本信息 */}
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500">检测时间：</span>
                      <span>{new Date(detailSession.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">策略名称：</span>
                      <span className="text-blue-600">{detailSession.policyName}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">检测方向：</span>
                      <span>{detailSession.direction === 'input' ? '输入检测' : detailSession.direction === 'output' ? '输出检测' : '双向检测'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">使用模型：</span>
                      <span>{detailSession.modelUsed || '-'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">延迟：</span>
                      <span>{detailSession.latencyMs ? `${detailSession.latencyMs}ms` : '-'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">风险等级：</span>
                      <span className="capitalize">{detailSession.riskLevel || '-'}</span>
                    </div>
                  </div>

                  {/* 用户输入（原文按数据最小化策略不再返回，仅在曾存储时提示） */}
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-gray-700">用户输入</div>
                    <div className="p-3 bg-gray-50 rounded-lg text-sm whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                      {detailSession.inputText
                        ?? (detailSession.contentStored ? '（原文未保留：已按数据最小化策略脱敏）' : '（原文未保留）')}
                    </div>
                  </div>

                  {/* 模型输出 */}
                  {detailSession.outputText && (
                    <div className="space-y-1">
                      <div className="text-sm font-medium text-gray-700">模型输出</div>
                      <div className="p-3 bg-gray-50 rounded-lg text-sm whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                        {detailSession.outputText}
                      </div>
                    </div>
                  )}

                  {/* 检测分数 */}
                  <div className="grid grid-cols-2 gap-4">
                    {detailSession.inputScore !== null && (
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <div className="text-xs text-gray-600 mb-1">输入检测</div>
                        <div className="flex items-center gap-2">
                          {detailSession.inputAction && getActionBadge(detailSession.inputAction)}
                          <span className="text-sm font-medium">风险分: {detailSession.inputScore}</span>
                        </div>
                      </div>
                    )}
                    {detailSession.outputScore !== null && (
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <div className="text-xs text-gray-600 mb-1">输出检测</div>
                        <div className="flex items-center gap-2">
                          {detailSession.outputAction && getActionBadge(detailSession.outputAction)}
                          <span className="text-sm font-medium">风险分: {detailSession.outputScore}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 风险维度详情 */}
                  {detailSession.findings && detailSession.findings.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-700">风险维度详情</div>
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {detailSession.findings.map((finding, idx) => (
                          <div key={idx} className="p-3 bg-red-50 rounded-lg border border-red-100">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="font-medium text-sm">{finding.dimensionName || finding.dimension}</span>
                              {getSeverityBadge(finding.severity)}
                              <span className="text-sm text-gray-600">风险分: {finding.score}</span>
                            </div>
                            {finding.matchedRules && finding.matchedRules.length > 0 && (
                              <div className="text-xs text-gray-600 mb-1">
                                命中规则: {finding.matchedRules.join('、')}
                              </div>
                            )}
                            {finding.evidence && finding.evidence.length > 0 && (
                              <div className="text-xs text-gray-600 mb-1">
                                证据: {finding.evidence.join('、')}
                              </div>
                            )}
                            {finding.reason && (
                              <div className="text-xs text-gray-600">
                                原因: {finding.reason}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 白名单命中信息 */}
                  {detailSession.whitelistMatched && (
                    <div className="p-3 bg-blue-50 rounded-lg border border-blue-200">
                      <div className="flex items-center gap-2 text-sm font-medium text-blue-700 mb-2">
                        <Shield className="h-4 w-4" />
                        白名单命中
                      </div>
                      <div className="text-sm space-y-1">
                        <div>
                          <span className="text-gray-500">命中白名单：</span>
                          <Badge variant="outline">{detailSession.whitelistMatched.name}</Badge>
                        </div>
                        <div>
                          <span className="text-gray-500">白名单类型：</span>
                          <span>{detailSession.whitelistMatched.policyScope === 'all' ? '全部策略' : '指定策略'}</span>
                          <span className="mx-1">|</span>
                          <span>{detailSession.whitelistMatched.dimensionScope === 'all' ? '全部维度' : '指定维度'}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 跳过的维度 */}
                  {detailSession.skippedDimensions && detailSession.skippedDimensions.length > 0 && (
                    <div className="p-3 bg-green-50 rounded-lg border border-green-200">
                      <div className="text-sm font-medium text-green-700 mb-2">
                        因白名单跳过的维度
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {detailSession.skippedDimensions.map((skipped, idx) => (
                          <div key={idx} className="text-sm bg-green-100 text-green-700 px-2 py-1 rounded">
                            {skipped.dimensionName}（因命中&quot;{skipped.whitelistName}&quot;）
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 裁判模型决策过程 */}
                  {(detailSession.inputJudgeResult?.used || detailSession.outputJudgeResult?.used) && (
                    <div className="space-y-3">
                      <div className="text-sm font-medium text-gray-700 flex items-center gap-2">
                        <Bot className="h-4 w-4 text-purple-600" />
                        裁判模型决策
                      </div>

                      {/* 输入检测裁判结果 */}
                      {detailSession.inputJudgeResult?.used && detailSession.inputDecisionTrace && (
                        <JudgeModelResultCard
                          judgeModelResult={detailSession.inputJudgeResult}
                          decisionTrace={detailSession.inputDecisionTrace}
                          displayMode="standard"
                          defaultExpanded={true}
                        />
                      )}

                      {/* 输出检测裁判结果 */}
                      {detailSession.outputJudgeResult?.used && detailSession.outputDecisionTrace && (
                        <JudgeModelResultCard
                          judgeModelResult={detailSession.outputJudgeResult}
                          decisionTrace={detailSession.outputDecisionTrace}
                          displayMode="standard"
                          defaultExpanded={true}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        </DetailPanel>
      </div>
    </div>
  );
}
