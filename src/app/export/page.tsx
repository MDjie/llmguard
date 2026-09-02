'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Download, FileJson, FileSpreadsheet, FileText, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

interface DetectionSession {
  id: string;
  user_prompt: string;
  input_score: number;
  input_action: string;
  final_action: string;
  created_at: string;
}

interface ExportStats {
  totalRecords: number;
  dateRange: string;
}

export default function ExportPage() {
  const [format, setFormat] = useState<'json' | 'csv' | 'markdown'>('json');
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');
  const [actionFilter, setActionFilter] = useState<'all' | 'allow' | 'warn' | 'block'>('all');
  const [exporting, setExporting] = useState(false);
  const [stats, setStats] = useState<ExportStats | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchStats() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('days', dateRange === 'all' ? '0' : dateRange);
      
      const response = await fetch(`/api/export/stats?${params}`);
      const data = await response.json();
      
      if (data.success) {
        setStats(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStats();
  }, [dateRange]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      params.set('format', format);
      params.set('dateRange', dateRange);
      if (actionFilter !== 'all') {
        params.set('action', actionFilter);
      }

      const response = await fetch(`/api/export?${params}`);
      
      if (!response.ok) {
        throw new Error('导出失败');
      }

      const data = await response.json();
      
      if (data.success) {
        // 创建下载链接
        const blob = new Blob([data.data.content], { 
          type: format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/markdown' 
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `guardrail-report-${new Date().toISOString().split('T')[0]}.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        toast.success('导出成功', {
          description: `已导出 ${data.data.recordCount || 0} 条记录`
        });
      } else {
        throw new Error(data.error || '导出失败');
      }
    } catch (error) {
      toast.error('导出失败', {
        description: error instanceof Error ? error.message : '请稍后重试'
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">导出报告</h1>
        <p className="text-muted-foreground mt-1">导出检测记录与安全分析报告</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* 导出配置 */}
        <Card>
          <CardHeader>
            <CardTitle>导出配置</CardTitle>
            <CardDescription>选择导出格式和筛选条件</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* 格式选择 */}
            <div className="space-y-2">
              <Label>导出格式</Label>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant={format === 'json' ? 'default' : 'outline'}
                  className="justify-start"
                  onClick={() => setFormat('json')}
                >
                  <FileJson className="h-4 w-4 mr-2" />
                  JSON
                </Button>
                <Button
                  variant={format === 'csv' ? 'default' : 'outline'}
                  className="justify-start"
                  onClick={() => setFormat('csv')}
                >
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                  CSV
                </Button>
                <Button
                  variant={format === 'markdown' ? 'default' : 'outline'}
                  className="justify-start"
                  onClick={() => setFormat('markdown')}
                >
                  <FileText className="h-4 w-4 mr-2" />
                  Markdown
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {format === 'json' && '适合程序处理，保留完整数据结构'}
                {format === 'csv' && '适合 Excel 打开，便于数据分析'}
                {format === 'markdown' && '适合文档报告，便于阅读分享'}
              </p>
            </div>

            {/* 时间范围 */}
            <div className="space-y-2">
              <Label>时间范围</Label>
              <Select value={dateRange} onValueChange={(v) => setDateRange(v as typeof dateRange)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7d">最近 7 天</SelectItem>
                  <SelectItem value="30d">最近 30 天</SelectItem>
                  <SelectItem value="90d">最近 90 天</SelectItem>
                  <SelectItem value="all">全部记录</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 动作筛选 */}
            <div className="space-y-2">
              <Label>处理动作</Label>
              <Select value={actionFilter} onValueChange={(v) => setActionFilter(v as typeof actionFilter)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部动作</SelectItem>
                  <SelectItem value="allow">放行</SelectItem>
                  <SelectItem value="warn">警告</SelectItem>
                  <SelectItem value="block">拦截</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button 
              className="w-full" 
              size="lg"
              onClick={handleExport}
              disabled={exporting || !stats || stats.totalRecords === 0}
            >
              {exporting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  导出中...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  导出报告
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* 数据统计 */}
        <Card>
          <CardHeader>
            <CardTitle>数据统计</CardTitle>
            <CardDescription>当前筛选条件下的数据概览</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !stats || stats.totalRecords === 0 ? (
              <div className="text-center py-8">
                <AlertCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">暂无可导出记录</p>
                <p className="text-sm text-muted-foreground mt-2">
                  执行检测任务后，数据将在此显示
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
                  <span className="font-medium">可导出记录数</span>
                  <Badge variant="secondary" className="text-lg">
                    {stats.totalRecords} 条
                  </Badge>
                </div>
                
                <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
                  <span className="font-medium">时间范围</span>
                  <span className="text-muted-foreground">
                    {dateRange === 'all' ? '全部' : 
                     dateRange === '7d' ? '最近 7 天' :
                     dateRange === '30d' ? '最近 30 天' : '最近 90 天'}
                  </span>
                </div>

                <div className="flex items-center gap-2 p-4 rounded-lg bg-green-500/10 text-green-600">
                  <CheckCircle2 className="h-5 w-5" />
                  <span>数据已准备就绪，可以导出</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 格式说明 */}
      <Card>
        <CardHeader>
          <CardTitle>格式说明</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FileJson className="h-5 w-5 text-blue-500" />
                <span className="font-medium">JSON 格式</span>
              </div>
              <p className="text-sm text-muted-foreground">
                包含完整的检测记录、风险分析、处理动作等信息，适合程序处理或数据迁移。
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5 text-green-500" />
                <span className="font-medium">CSV 格式</span>
              </div>
              <p className="text-sm text-muted-foreground">
                表格格式，可用 Excel 或 Google Sheets 打开，便于数据分析和统计图表制作。
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-purple-500" />
                <span className="font-medium">Markdown 格式</span>
              </div>
              <p className="text-sm text-muted-foreground">
                人类可读的文档格式，适合生成安全报告或分享给团队成员审阅。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
