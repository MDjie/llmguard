'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, RefreshCw, ChevronLeft, ChevronRight, FileText, Clock, Zap } from 'lucide-react';

import { agentLogsResponseSchema, type AgentLog } from '@/contracts/http/agent-logs';

export default function AgentLogsPage() {
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [workflowType, setWorkflowType] = useState<string>('all');

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: '10',
      });
      if (workflowType && workflowType !== 'all') {
        params.set('workflowType', workflowType);
      }

      const response = await fetch(`/api/agent-logs?${params}`);
      const data = await response.json();

      const parsed = agentLogsResponseSchema.safeParse(data);
      if (response.ok && parsed.success) {
        setLogs(parsed.data.data.items);
        setTotalPages(Math.max(1, parsed.data.data.totalPages));
      } else {
        setError(data.error || '加载失败');
      }
    } catch {
      setError('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [page, workflowType]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'success':
        return <Badge variant="default" className="bg-green-500">成功</Badge>;
      case 'failed':
        return <Badge variant="destructive">失败</Badge>;
      case 'timeout':
        return <Badge variant="secondary">超时</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getWorkflowTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      detection: 'bg-blue-500',
      pii_mask: 'bg-yellow-500',
      rewrite: 'bg-purple-500',
      judge: 'bg-pink-500',
    };
    return (
      <Badge variant="default" className={colors[type] || 'bg-gray-500'}>
        {type === 'pii_mask' ? 'PII脱敏' : type === 'detection' ? '安全检测' : type === 'rewrite' ? '安全改写' : type}
      </Badge>
    );
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Agent 日志</h1>
          <p className="text-muted-foreground mt-1">查看 LLM 调用与工作流执行日志</p>
        </div>
        <Button onClick={fetchLogs} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          刷新
        </Button>
      </div>

      {/* 筛选条件 */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium">工作流类型：</span>
            <Select value={workflowType} onValueChange={setWorkflowType}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="全部类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="detection">安全检测</SelectItem>
                <SelectItem value="pii_mask">PII脱敏</SelectItem>
                <SelectItem value="rewrite">安全改写</SelectItem>
                <SelectItem value="judge">Judge LLM</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* 日志列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">加载中...</span>
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" className="mt-4" onClick={fetchLogs}>
              重试
            </Button>
          </CardContent>
        </Card>
      ) : logs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">暂无 Agent 调用日志</p>
            <p className="text-sm text-muted-foreground mt-2">执行检测任务后，日志将在此显示</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {logs.map((log) => (
            <Card key={log.id}>
              <CardContent className="pt-6">
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 break-all space-y-2 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {getWorkflowTypeBadge(log.workflowName ?? '未记录')}
                      {getStatusBadge(log.success === null ? '未知（历史结果未记录）' : log.success ? 'success' : 'failed')}
                      <span className="text-sm text-muted-foreground">
                        {log.providerId ?? '未关联模型'}
                      </span>
                    </div>
                    <div className="text-sm">
                      <span className="font-medium">检测记录:</span> {log.recordId ?? '未关联'}
                    </div>

                  </div>
                  <div className="text-right space-y-2">
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Zap className="h-4 w-4" />
                        {log.latencyMs === null ? '耗时未记录' : log.latencyMs + 'ms'}
                      </div>
                      <div>
                        Token 统计见裁判调用记录
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-sm text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      {new Date(log.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <span className="text-sm text-muted-foreground">
            第 {page} / {totalPages} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
