'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Search, Trash2, Eye, RefreshCw, AlertCircle, AlertTriangle, CheckCircle2, CalendarIcon, X, Filter, Shield, Bot, Zap, GitMerge, type LucideIcon } from 'lucide-react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import JudgeModelResultCard from '@/components/judge/JudgeModelResultCard';

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
  inputText: string;
  outputText: string | null;
  action: string;
  inputAction: string | null;
  outputAction: string | null;
  inputScore: number | null;
  outputScore: number | null;
  policyName: string;
  direction: string;
  modelUsed: string;
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

export default function HistoryPage() {
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
  const [showFilters, setShowFilters] = useState(false);
  const [detailSession, setDetailSession] = useState<Session | null>(null);

  const fetchHistory = async (page = 1) => {
    setLoading(true);
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
      
      if (data.success && data.data) {
        setSessions(data.data.sessions || []);
        setPagination(data.data.pagination || { page: 1, limit: pagination.limit, total: 0, totalPages: 0 });
      }
    } catch (error) {
      console.error('加载历史记录失败:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory(1);
  }, [filter, pagination.limit]);

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
      const res = await fetch(`/api/history?id=${id}`, { method: 'DELETE' });
      
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
    const styles: Record<string, { variant: 'destructive' | 'default' | 'secondary'; icon: LucideIcon; text: string }> = {
      block: { variant: 'destructive', icon: AlertCircle, text: '拒绝' },
      warn: { variant: 'default', icon: AlertTriangle, text: '警告' },
      allow: { variant: 'secondary', icon: CheckCircle2, text: '放行' },
    };
    
    const style = styles[action] || styles.allow;
    const Icon = style.icon;
    
    return (
      <Badge variant={style.variant} className="flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {style.text}
      </Badge>
    );
  };

  const getDimensionName = (dimension: string) => {
    const names: Record<string, string> = {
      'prompt_injection': '提示词注入',
      'pii_leak': 'PII泄露',
      'malicious_code': '恶意代码',
      'violence_hate': '暴力仇恨',
      'illegal_content': '非法内容',
    };
    return names[dimension] || dimension;
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
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">历史记录</h1>
        <p className="text-gray-600 mt-1">查看和管理所有检测记录</p>
      </div>

      {/* 筛选栏 */}
      <Card>
        <CardContent className="pt-6">
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
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">加载中...</div>
        </div>
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center h-64">
            <div className="text-gray-500 mb-4">暂无检测记录</div>
            <Button onClick={() => fetchHistory(1)}>刷新</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sessions.map((session) => (
            <Card key={session.id}>
              <CardContent className="pt-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      {getActionBadge(session.action)}
                      <span className="text-xs text-gray-500">
                        {new Date(session.createdAt).toLocaleString()}
                      </span>
                      <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                        {session.policyName}
                      </span>
                      <span className="text-xs text-gray-500">
                        {session.modelUsed}
                      </span>
                    </div>
                    <div className="text-sm text-gray-900 font-medium">
                      用户输入: {session.inputText}
                    </div>
                    {session.outputText && (
                      <div className="text-sm text-gray-600 mt-1">
                        模型输出: {session.outputText.substring(0, 100)}...
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setDetailSession(session)}>
                      <Eye className="h-4 w-4 text-blue-500" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm">
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
                </div>
              </div>

              {/* 风险明细 */}
                <div className="grid grid-cols-2 gap-4 mt-4">
                  {session.inputScore !== null && (
                    <div className="p-3 bg-gray-50 rounded">
                      <div className="text-xs text-gray-600 mb-1">输入检测</div>
                      <div className="flex items-center gap-2">
                        {session.inputAction && getActionBadge(session.inputAction)}
                        <span className="text-sm font-medium">风险分: {session.inputScore}</span>
                      </div>
                    </div>
                  )}
                  {session.outputScore !== null && (
                    <div className="p-3 bg-gray-50 rounded">
                      <div className="text-xs text-gray-600 mb-1">输出检测</div>
                      <div className="flex items-center gap-2">
                        {session.outputAction && getActionBadge(session.outputAction)}
                        <span className="text-sm font-medium">风险分: {session.outputScore}</span>
                      </div>
                    </div>
                  )}
                  {session.latencyMs !== null && (
                    <div className="p-3 bg-gray-50 rounded">
                      <div className="text-xs text-gray-600 mb-1">延迟</div>
                      <div className="text-sm font-medium">{session.latencyMs}ms</div>
                    </div>
                  )}
                  {session.riskLevel && (
                    <div className="p-3 bg-gray-50 rounded">
                      <div className="text-xs text-gray-600 mb-1">风险等级</div>
                      <div className="text-sm font-medium capitalize">{session.riskLevel}</div>
                    </div>
                  )}
                </div>

                {/* 风险维度 */}
                {session.findings && session.findings.length > 0 && (
                  <div className="mt-4">
                    <div className="text-xs text-gray-600 mb-2">风险维度</div>
                    <div className="flex flex-wrap gap-2">
                      {session.findings.map((finding, idx) => (
                        <div key={idx} className="px-3 py-1 bg-gray-100 rounded text-xs flex items-center gap-2">
                          <span className="font-medium">{finding.dimensionName || finding.dimension}</span>
                          <span className="text-gray-600">分数: {finding.score}</span>
                          {getSeverityBadge(finding.severity)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 白名单命中信息 */}
                {session.whitelistMatched && (
                  <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                    <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-400 mb-2">
                      <Shield className="h-4 w-4" />
                      白名单命中
                    </div>
                    <div className="text-sm space-y-1">
                      <div>
                        <span className="text-gray-500">命中白名单：</span>
                        <Badge variant="outline" className="ml-1">{session.whitelistMatched.name}</Badge>
                      </div>
                      <div>
                        <span className="text-gray-500">白名单类型：</span>
                        <span className="ml-1">{session.whitelistMatched.policyScope === 'all' ? '全部策略' : '指定策略'}</span>
                        <span className="mx-1">|</span>
                        <span>{session.whitelistMatched.dimensionScope === 'all' ? '全部维度' : '指定维度'}</span>
                      </div>
                      {session.whitelistMatched.effect && (
                        <div className="text-blue-600 dark:text-blue-400">
                          {session.whitelistMatched.effect === 'skip_all_detection' 
                            ? '命中全局白名单，已跳过所有风险检测' 
                            : '命中维度白名单，已跳过指定维度检测'}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 跳过的维度 */}
                {session.skippedDimensions && session.skippedDimensions.length > 0 && (
                  <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                    <div className="text-sm font-medium text-green-700 dark:text-green-400 mb-2">
                      因白名单跳过的维度
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {session.skippedDimensions.map((skipped, idx) => (
                        <div key={idx} className="text-sm bg-green-100 dark:bg-green-800 text-green-700 dark:text-green-300 px-2 py-1 rounded">
                          {skipped.dimensionName}（因命中&quot;{skipped.whitelistName}&quot;）
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

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
                  <div className="flex items-center gap-1 mx-2">
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
        </div>
      )}

      {/* 详情弹窗 */}
      <AlertDialog open={!!detailSession} onOpenChange={(open) => !open && setDetailSession(null)}>
        <AlertDialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              检测详情
              {detailSession && getActionBadge(detailSession.action)}
            </AlertDialogTitle>
            <AlertDialogDescription className="sr-only">
              查看检测记录的详细信息
            </AlertDialogDescription>
            <div className="text-left text-muted-foreground text-sm">
              {detailSession && (
                <div className="space-y-4 mt-2">
                  {/* 基本信息 */}
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500">检测时间：</span>
                      <span>{new Date(detailSession.createdAt).toLocaleString()}</span>
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

                  {/* 用户输入 */}
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-gray-700">用户输入</div>
                    <div className="p-3 bg-gray-50 rounded-lg text-sm whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                      {detailSession.inputText || '-'}
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
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setDetailSession(null)}>关闭</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
