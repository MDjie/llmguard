'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle, AlertTriangle, Shield, Eye, Clock, TrendingUp, BarChart3, RefreshCw, XCircle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart, PieChart, Pie, Cell } from 'recharts';

interface StatsData {
  totalDetections: number;
  todayDetections: number;
  actionDistribution: {
    allow: number;
    warn: number;
    block: number;
    mask: number;
    rewrite: number;
  };
  riskDistribution: Record<string, number>;
  avgScore: number | null;
  avgLatency: number | null;
  blockRate: string;
  trend: Array<{ date: string; count: number; blockCount: number; warnCount: number; maskCount: number }>;
}

interface InterceptionItem {
  id: string;
  inputText: string;
  action: string;
  inputScore: number | null;
  createdAt: string;
  findings: Array<{
    dimension: string;
    dimensionName: string;
    score: number;
    severity: string;
  }>;
}

const dimensionLabels: Record<string, string> = {
  malicious_code: '恶意代码',
  violence_hate: '暴力仇恨',
  illegal_content: '非法内容',
  spam_detection: '垃圾信息',
  ad_detection: '广告检测',
  prompt_injection: '提示词注入',
  sensitive_compliance: '敏感合规',
  adult_content: '成人内容',
  self_harm: '自我伤害',
  credential_secret_leak: '密钥泄露',
  fraud_scam: '诈骗欺诈',
  misinformation: '虚假信息',
  copyright_risk: '版权风险',
  business_sensitive: '商业敏感',
  output_leak: '输出泄露',
  pii_leak: 'PII泄露',
};

export default function DashboardPage() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [interceptions, setInterceptions] = useState<InterceptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      // 并行获取统计数据和拦截列表
      const [statsRes, interceptionsRes] = await Promise.all([
        fetch('/api/stats'),
        fetch('/api/history?action=block&limit=10')
      ]);
      
      const statsResult = await statsRes.json();
      const interceptionsResult = await interceptionsRes.json();
      
      if (statsResult.success) {
        setStats(statsResult.data);
      } else {
        setError(statsResult.error || '获取统计数据失败');
      }
      
      if (interceptionsResult.success && interceptionsResult.data) {
        setInterceptions(interceptionsResult.data.sessions || []);
      }
    } catch (err) {
      setError('加载数据失败');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">加载中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-red-500">
          <AlertCircle className="h-12 w-12 mx-auto mb-4" />
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!stats) return null;

  const totalActions = Object.values(stats.actionDistribution).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">检测看板</h1>
        <p className="text-muted-foreground mt-2">安全护栏运行状态与风险分析</p>
      </div>

      {/* 核心指标卡片 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">总检测次数</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalDetections}</div>
            <p className="text-xs text-muted-foreground mt-1">
              今日 {stats.todayDetections} 次
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">拦截率</CardTitle>
            <AlertCircle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.blockRate}</div>
            <p className="text-xs text-muted-foreground mt-1">
              阻断 {stats.actionDistribution.block} 次
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">平均风险分</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.avgScore !== null ? stats.avgScore.toFixed(1) : '--'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              分数范围 0-100
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">平均延迟</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.avgLatency !== null ? `${stats.avgLatency.toFixed(0)}ms` : '--'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              检测响应时间
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 处理动作分布 & 风险维度分布 */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* 处理动作分布 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              处理动作分布
            </CardTitle>
            <CardDescription>各类处理动作的执行次数</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {[
                { key: 'allow', label: '放行', color: 'bg-green-500', icon: CheckCircle },
                { key: 'block', label: '拦截', color: 'bg-red-500', icon: AlertCircle },
                { key: 'warn', label: '警告', color: 'bg-yellow-500', icon: AlertTriangle },
                { key: 'mask', label: '脱敏', color: 'bg-blue-500', icon: Eye },
              ].map(({ key, label, color, icon: Icon }) => {
                const count = stats.actionDistribution[key as keyof typeof stats.actionDistribution] || 0;
                const percentage = totalActions > 0 ? (count / totalActions) * 100 : 0;
                return (
                  <div key={key} className="flex items-center gap-4">
                    <div className="flex items-center gap-2 w-20">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{label}</span>
                    </div>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${percentage}%` }} />
                    </div>
                    <div className="w-16 text-right text-sm text-muted-foreground">
                      {count} ({percentage.toFixed(1)}%)
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* 风险维度饼图 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              风险维度分布
            </CardTitle>
            <CardDescription>各维度风险检出占比</CardDescription>
          </CardHeader>
          <CardContent>
            {Object.values(stats.riskDistribution).every(c => c === 0) ? (
              <div className="text-center text-muted-foreground py-8">
                暂无风险检出记录
              </div>
            ) : (
              <div className="flex items-center gap-6">
                <div className="w-[220px] h-[220px] flex-shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={Object.entries(stats.riskDistribution)
                          .filter(([, count]) => count > 0)
                          .sort(([, a], [, b]) => b - a)
                          .map(([dimension, count]) => ({
                            name: dimensionLabels[dimension] || dimension,
                            value: count,
                          }))
                        }
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={85}
                        paddingAngle={3}
                        dataKey="value"
                        strokeWidth={1}
                        stroke="hsl(var(--card))"
                      >
                        {Object.entries(stats.riskDistribution)
                          .filter(([, count]) => count > 0)
                          .sort(([, a], [, b]) => b - a)
                          .map((_, index) => {
                            const colors = ['#6366f1', '#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#84cc16', '#06b6d4'];
                            return <Cell key={index} fill={colors[index % colors.length]} />;
                          })
                        }
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number, name: string) => [`${value} 次`, name]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex-1 space-y-2">
                  {Object.entries(stats.riskDistribution)
                    .filter(([, count]) => count > 0)
                    .sort(([, a], [, b]) => b - a)
                    .map(([dimension, count], index) => {
                      const colors = ['#6366f1', '#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#84cc16', '#06b6d4'];
                      const total = Object.values(stats.riskDistribution).reduce((a, b) => a + b, 0);
                      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
                      return (
                        <div key={dimension} className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: colors[index % colors.length] }} />
                          <span className="text-sm flex-1 truncate">{dimensionLabels[dimension] || dimension}</span>
                          <span className="text-sm font-medium">{count}</span>
                          <span className="text-xs text-muted-foreground w-12 text-right">{pct}%</span>
                        </div>
                      );
                    })
                  }
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 趋势图 */}
      <Card>
        <CardHeader>
          <CardTitle>检测趋势</CardTitle>
          <CardDescription>最近7天检测次数变化（总体 / 拦截 / 警告 / 脱敏）</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.trend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorBlock" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorWarn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorMask" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="date" 
                  tickFormatter={(date) => {
                    const d = new Date(date + 'T00:00:00');
                    return `${d.getMonth() + 1}/${d.getDate()}`;
                  }}
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                />
                <YAxis 
                  allowDecimals={false}
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  labelFormatter={(date) => {
                    const d = new Date(date + 'T00:00:00');
                    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
                  }}
                  formatter={(value: number, name: string) => {
                    const labels: Record<string, string> = {
                      count: '总检测',
                      blockCount: '拦截',
                      warnCount: '警告',
                      maskCount: '脱敏',
                    };
                    return [`${value} 次`, labels[name] || name];
                  }}
                />
                <Area 
                  type="monotone" 
                  dataKey="count" 
                  stroke="#6366f1"
                  strokeWidth={2}
                  fill="url(#colorTotal)"
                  name="count"
                />
                <Area 
                  type="monotone" 
                  dataKey="blockCount" 
                  stroke="#ef4444"
                  strokeWidth={2}
                  fill="url(#colorBlock)"
                  name="blockCount"
                />
                <Area 
                  type="monotone" 
                  dataKey="warnCount" 
                  stroke="#f59e0b"
                  strokeWidth={2}
                  fill="url(#colorWarn)"
                  name="warnCount"
                />
                <Area 
                  type="monotone" 
                  dataKey="maskCount" 
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#colorMask)"
                  name="maskCount"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {/* 图例 */}
          <div className="flex items-center justify-center gap-6 mt-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#6366f1]"></div>
              <span className="text-sm text-muted-foreground">总体数量</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#ef4444]"></div>
              <span className="text-sm text-muted-foreground">拦截数量</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#f59e0b]"></div>
              <span className="text-sm text-muted-foreground">警告数量</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#3b82f6]"></div>
              <span className="text-sm text-muted-foreground">脱敏数量</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 实时拦截列表 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <XCircle className="h-5 w-5 text-red-500" />
                实时拦截列表
              </CardTitle>
              <CardDescription>最近被拦截的请求</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={fetchData}>
              <RefreshCw className="h-4 w-4 mr-2" />
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {interceptions.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              暂无拦截记录
            </div>
          ) : (
            <div className="space-y-3">
              {interceptions.map((item) => (
                <div key={item.id} className="border rounded-lg p-4 hover:bg-muted/50 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="destructive" className="flex items-center gap-1">
                          <XCircle className="h-3 w-3" />
                          已拦截
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(item.createdAt).toLocaleString()}
                        </span>
                        {item.inputScore !== null && (
                          <Badge variant="outline" className="text-xs">
                            风险分: {item.inputScore}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm truncate" title={item.inputText}>
                        {item.inputText}
                      </p>
                      {item.findings && item.findings.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {item.findings.slice(0, 3).map((finding, idx) => (
                            <Badge key={idx} variant="secondary" className="text-xs">
                              {dimensionLabels[finding.dimension] || finding.dimensionName || finding.dimension}
                            </Badge>
                          ))}
                          {item.findings.length > 3 && (
                            <Badge variant="secondary" className="text-xs">
                              +{item.findings.length - 3} 更多
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
