'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Save,
  Plus,
  Trash2,
  Download,
  Upload,
  Search,
  FileText,
  History,
  Shield,
  Tag,
  GitCompare,
  Bot,
  ArrowUpCircle,
} from 'lucide-react';
import { ABComparePanel } from './components/ABComparePanel';
import { JudgeConfigPanel } from './components/JudgeConfigPanel';
import { EscalationConfigPanel } from './components/EscalationConfigPanel';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { PromptInjectionCatalogPanel } from '@/components/content-safety/PromptInjectionCatalogPanel';
import { parseKeywordBatchText } from '@/lib/policy/keyword-batch-parser';

interface PolicyDetail {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  tags: string[];
  rules: Array<{
    id: string;
    dimension: string;
    enabled: boolean;
    warn_enabled: boolean;
    block_enabled: boolean;
    warn_threshold: number;
    block_threshold: number;
    auto_mask: boolean;
    auto_rewrite: boolean;
  }>;
  categories: Array<{
    id: string;
    name: string;
    dimension: string;
    priority: number;
    enabled: boolean;
  }>;
  keywords: Array<{
    id: string;
    keyword: string;
    dimension: string;
    score: number;
    match_type: string;
    case_sensitive: boolean;
    enabled: boolean;
    description: string;
    category?: { id: string; name: string } | null;
  }>;
  versions: Array<{
    id: string;
    version: number;
    change_summary: string;
    changed_by: string;
    created_at: string;
  }>;
  stats: {
    totalRules: number;
    totalKeywords: number;
    totalCategories: number;
  };
}

export default function PolicyDetailPage() {
  const params = useParams();
  const router = useRouter();
  const policyId = params.id as string;

  // 动态加载的检测维度
  const [dimensions, setDimensions] = useState<Array<{ value: string; label: string; description: string }>>([]);

  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('rules');

  // 关键词管理状态
  const [keywordDialogOpen, setKeywordDialogOpen] = useState(false);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [keywordForm, setKeywordForm] = useState({
    keyword: '',
    dimension: 'prompt_injection',
    score: 90,
    matchType: 'exact',
    caseSensitive: false,
    description: '',
  });
  const [batchKeywords, setBatchKeywords] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [abPanelOpen, setAbPanelOpen] = useState(false);

  // 加载策略详情
  const loadPolicy = async () => {
    try {
      const res = await fetch(`/api/policies/${policyId}`);
      const data = await res.json();
      if (data.success) {
        setPolicy(data.data);
      } else {
        toast.error('加载失败: ' + data.error);
        router.push('/policies');
      }
    } catch (error) {
      toast.error('加载失败: 网络错误');
    } finally {
      setLoading(false);
    }
  };

  // 加载检测维度
  async function loadDimensions() {
    try {
      const res = await fetch('/api/dimensions');
      const data = await res.json();
      if (data.success) {
        setDimensions(
          data.data
            .filter((d: { enabled: boolean }) => d.enabled)
            .map((d: { code: string; name: string; description: string }) => ({
              value: d.code,
              label: d.name,
              description: d.description || '',
            }))
        );
      }
    } catch (error) {
      console.error('加载维度失败:', error);
    }
  }

  useEffect(() => {
    loadPolicy();
    loadDimensions();
  }, [policyId]);

  // 保存规则
  const handleSaveRules = async () => {
    if (!policy) return;
    setSaving(true);

    try {
      const res = await fetch('/api/policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          policyId: policy.id,
          rules: policy.rules,
        }),
      });

      const data = await res.json();
      if (data.success) {
        toast.success('规则配置已更新');
        loadPolicy();
      } else {
        // 后端校验失败时返回 RFC7807 problem(RFC 7807 problem: 无 success/error 字段),
        // 依序取 error/detail/errors 里的可读信息, 避免显示 "保存失败: undefined"
        const reason =
          data?.error ??
          data?.detail ??
          data?.errors?.[0]?.message ??
          `请求被拒绝 (${res.status})`;
        toast.error('保存失败: ' + reason);
      }
    } catch (error) {
      toast.error('保存失败: 网络错误');
    } finally {
      setSaving(false);
    }
  };

  // 更新规则（支持用 dimension 或 id 匹配）
  const updateRule = (identifier: string, field: string, value: unknown) => {
    if (!policy) return;
    setPolicy({
      ...policy,
      rules: policy.rules.map((r) => {
        // 用 dimension 匹配（支持新增规则）
        if (r.dimension === identifier) {
          return { ...r, [field]: value };
        }
        // 用 id 匹配
        if (r.id === identifier) {
          return { ...r, [field]: value };
        }
        return r;
      }),
    });
  };

  // 添加关键词
  const handleAddKeyword = async () => {
    if (!keywordForm.keyword.trim()) {
      toast.error('关键词不能为空');
      return;
    }

    try {
      const res = await fetch(`/api/policies/${policyId}/keywords`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          ...keywordForm,
          categoryId: categoryId || undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        toast.success('关键词添加成功');
        setKeywordDialogOpen(false);
        setKeywordForm({
          keyword: '',
          dimension: 'prompt_injection',
          score: 90,
          matchType: 'exact',
          caseSensitive: false,
          description: '',
        });
        loadPolicy();
      } else {
        toast.error('添加失败: ' + data.error);
      }
    } catch (error) {
      toast.error('添加失败: 网络错误');
    }
  };

  // 批量添加关键词
  const handleBatchAdd = async () => {
    const parsed = parseKeywordBatchText(batchKeywords);
    const keywords = parsed.items;

    if (parsed.issues.length > 0) {
      toast.error(parsed.issues[0]?.message ?? '批量导入格式错误');
      return;
    }
    if (keywords.length === 0) {
      toast.error('请输入有效关键词');
      return;
    }
    if (parsed.duplicateRows > 0) toast.info(`已忽略 ${parsed.duplicateRows} 条重复关键词`);

    try {
      const res = await fetch(`/api/policies/${policyId}/keywords/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          keywords,
          categoryId: categoryId || undefined,
          dimension: keywordForm.dimension,
        }),
      });

      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        setBatchDialogOpen(false);
        setBatchKeywords('');
        loadPolicy();
      } else {
        toast.error('添加失败: ' + data.error);
      }
    } catch (error) {
      toast.error('添加失败: 网络错误');
    }
  };

  // 删除关键词
  const handleDeleteKeyword = async (keywordId: string) => {
    try {
      const res = await fetch(`/api/policies/${policyId}/keywords?keywordId=${keywordId}`, {
        method: 'DELETE',
        headers: { ...csrfHeaders() },
      });

      const data = await res.json();
      if (data.success) {
        toast.success('关键词已删除');
        loadPolicy();
      } else {
        toast.error('删除失败: ' + data.error);
      }
    } catch (error) {
      toast.error('删除失败: 网络错误');
    }
  };

  // 导出关键词
  const handleExportKeywords = async () => {
    try {
      const res = await fetch(`/api/policies/${policyId}/keywords/export?format=csv`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `keywords-${policyId}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      toast.error('导出失败: 网络错误');
    }
  };

  // 获取维度显示名称
  const getDimensionLabel = (dimension: string) => {
    const dim = dimensions.find((d) => d.value === dimension);
    return dim?.label || dimension;
  };

  // 过滤关键词
  const filteredKeywords = policy?.keywords.filter((k) =>
    k.keyword.toLowerCase().includes(searchQuery.toLowerCase()) ||
    getDimensionLabel(k.dimension).includes(searchQuery)
  ) || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  if (!policy) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* 页面头部 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/policies">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              {policy.name}
              {policy.isDefault && (
                <Badge variant="default">默认</Badge>
              )}
            </h1>
            <p className="text-muted-foreground">{policy.description || '暂无描述'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {policy.tags && policy.tags.length > 0 && (
            <div className="flex items-center gap-1">
              <Tag className="h-4 w-4 text-muted-foreground" />
              {policy.tags.map((tag) => (
                <Badge key={tag} variant="secondary">{tag}</Badge>
              ))}
            </div>
          )}
          <Badge variant="outline">版本 {policy.version}</Badge>
          <Button
            variant="default"
            size="sm"
            onClick={() => setAbPanelOpen(true)}
            className="gap-2"
          >
            <GitCompare className="h-4 w-4" />
            A/B 策略对比
          </Button>
        </div>
      </div>

      {/* Tab 内容 */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="rules">
              <Shield className="h-4 w-4 mr-2" />
              规则配置
            </TabsTrigger>
            <TabsTrigger value="judge">
              <Bot className="h-4 w-4 mr-2" />
              裁判模型
            </TabsTrigger>
            <TabsTrigger value="escalation">
              <ArrowUpCircle className="h-4 w-4 mr-2" />
              策略升级
            </TabsTrigger>
            <TabsTrigger value="keywords">
              <FileText className="h-4 w-4 mr-2" />
              关键词管理 ({policy.stats.totalKeywords})
            </TabsTrigger>
            <TabsTrigger value="history">
              <History className="h-4 w-4 mr-2" />
              版本历史
            </TabsTrigger>
          </TabsList>
        </div>

        {/* 规则配置 Tab */}
        <TabsContent value="rules" className="space-y-4">
          {/* A/B 对比推荐卡片 */}
          <div className="rounded-lg border bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-950/30 dark:to-purple-950/30 p-4 flex items-center justify-between">
            <div>
              <div className="font-medium flex items-center gap-2">
                <GitCompare className="h-4 w-4 text-primary" />
                想验证当前策略效果？
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                使用 A/B 对比测试同一输入在不同策略下的评分、动作和命中规则差异。
              </div>
            </div>
            <Button onClick={() => setAbPanelOpen(true)} className="gap-2 shrink-0">
              <GitCompare className="h-4 w-4" />
              开始对比
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>检测规则配置</CardTitle>
              <CardDescription>
                配置各维度的检测阈值和自动处理策略
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {policy.rules.map((rule) => {
                  const dimInfo = dimensions.find((d) => d.value === rule.dimension);
                  // 使用 dimension 作为 key 和 identifier（支持新增规则）
                  const ruleKey = rule.dimension;
                  return (
                    <div key={ruleKey} className="border rounded-lg p-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={rule.enabled}
                            onCheckedChange={(checked) => updateRule(ruleKey, 'enabled', checked)}
                          />
                          <div>
                            <div className="font-medium">{dimInfo?.label || rule.dimension}</div>
                            <div className="text-sm text-muted-foreground">
                              {dimInfo?.description}
                            </div>
                          </div>
                        </div>
                      </div>

                      {rule.enabled && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                          <div className="space-y-2">
                            <div className="flex justify-between items-center text-sm">
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={rule.warn_enabled}
                                  onCheckedChange={(checked) => updateRule(ruleKey, 'warn_enabled', checked)}
                                />
                                <span>警告阈值</span>
                              </div>
                              <span className={`font-mono ${!rule.warn_enabled ? 'text-muted-foreground' : ''}`}>
                                {rule.warn_enabled ? rule.warn_threshold : '已关闭'}
                              </span>
                            </div>
                            <Slider
                              value={[rule.warn_threshold]}
                              onValueChange={([value]) => updateRule(ruleKey, 'warn_threshold', value)}
                              min={0}
                              max={100}
                              step={5}
                              disabled={!rule.warn_enabled}
                              className={!rule.warn_enabled ? 'opacity-50' : ''}
                            />
                          </div>
                          <div className="space-y-2">
                            <div className="flex justify-between items-center text-sm">
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={rule.block_enabled}
                                  onCheckedChange={(checked) => updateRule(ruleKey, 'block_enabled', checked)}
                                />
                                <span>阻断阈值</span>
                              </div>
                              <span className={`font-mono ${!rule.block_enabled ? 'text-muted-foreground' : ''}`}>
                                {rule.block_enabled ? rule.block_threshold : '已关闭'}
                              </span>
                            </div>
                            <Slider
                              value={[rule.block_threshold]}
                              onValueChange={([value]) => updateRule(ruleKey, 'block_threshold', value)}
                              min={0}
                              max={100}
                              step={5}
                              disabled={!rule.block_enabled}
                              className={!rule.block_enabled ? 'opacity-50' : ''}
                            />
                          </div>
                        </div>
                      )}

                      {rule.enabled && (
                        <div className="flex items-center gap-6">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={rule.auto_mask}
                              onCheckedChange={(checked) => updateRule(ruleKey, 'auto_mask', checked)}
                            />
                            <span className="text-sm">自动脱敏</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={rule.auto_rewrite}
                              onCheckedChange={(checked) => updateRule(ruleKey, 'auto_rewrite', checked)}
                            />
                            <span className="text-sm">安全改写</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 flex justify-end">
                <Button onClick={handleSaveRules} disabled={saving}>
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? '保存中...' : '保存更改'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 裁判模型配置 Tab */}
        <TabsContent value="judge" className="space-y-4">
          <JudgeConfigPanel policyId={policyId} />
        </TabsContent>

        {/* 策略升级配置 Tab */}
        <TabsContent value="escalation" className="space-y-4">
          <EscalationConfigPanel policyId={policyId} />
        </TabsContent>

        {/* 关键词管理 Tab */}
        <TabsContent value="keywords" className="space-y-4">
          <PromptInjectionCatalogPanel />
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>关键词管理</CardTitle>
                  <CardDescription>管理自定义检测关键词</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={handleExportKeywords}>
                    <Download className="h-4 w-4 mr-2" />
                    导出
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setBatchDialogOpen(true)}>
                    <Upload className="h-4 w-4 mr-2" />
                    批量导入
                  </Button>
                  <Button size="sm" onClick={() => setKeywordDialogOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    添加关键词
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* 搜索框 */}
              <div className="mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="搜索关键词..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              {/* 关键词表格 */}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>关键词</TableHead>
                    <TableHead>维度</TableHead>
                    <TableHead>分数</TableHead>
                    <TableHead>匹配类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredKeywords.slice(0, 50).map((keyword) => (
                    <TableRow key={keyword.id}>
                      <TableCell className="font-mono">{keyword.keyword}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{getDimensionLabel(keyword.dimension)}</Badge>
                      </TableCell>
                      <TableCell>{keyword.score}</TableCell>
                      <TableCell>{keyword.match_type}</TableCell>
                      <TableCell>
                        <Badge variant={keyword.enabled ? 'default' : 'secondary'}>
                          {keyword.enabled ? '启用' : '禁用'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteKeyword(keyword.id)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {filteredKeywords.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  {searchQuery ? '未找到匹配的关键词' : '暂无关键词'}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* 版本历史 Tab */}
        <TabsContent value="history" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>版本历史</CardTitle>
              <CardDescription>查看策略的变更记录</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {policy.versions.map((v) => (
                  <div key={v.id} className="flex items-start gap-4 p-4 border rounded-lg">
                    <div className="bg-primary/10 rounded-full p-2">
                      <History className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">版本 {v.version}</span>
                        <span className="text-sm text-muted-foreground">
                          {new Date(v.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {v.change_summary || '无变更说明'}
                      </div>
                      {v.changed_by && (
                        <div className="text-xs text-muted-foreground mt-1">
                          操作人: {v.changed_by}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {policy.versions.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    暂无版本记录
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 添加关键词对话框 */}
      <Dialog open={keywordDialogOpen} onOpenChange={setKeywordDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加关键词</DialogTitle>
            <DialogDescription>添加新的检测关键词</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>关键词 *</Label>
              <Input
                value={keywordForm.keyword}
                onChange={(e) => setKeywordForm({ ...keywordForm, keyword: e.target.value })}
                placeholder="输入关键词"
              />
            </div>
            <div className="space-y-2">
              <Label>维度 *</Label>
              <Select
                value={keywordForm.dimension}
                onValueChange={(value) => setKeywordForm({ ...keywordForm, dimension: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dimensions.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>风险分数: {keywordForm.score}</Label>
              <Slider
                value={[keywordForm.score]}
                onValueChange={([value]) => setKeywordForm({ ...keywordForm, score: value })}
                min={0}
                max={100}
                step={5}
              />
            </div>
            <div className="space-y-2">
              <Label>匹配类型</Label>
              <Select
                value={keywordForm.matchType}
                onValueChange={(value) => setKeywordForm({ ...keywordForm, matchType: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exact">精确匹配</SelectItem>
                  <SelectItem value="prefix">前缀匹配</SelectItem>
                  <SelectItem value="suffix">后缀匹配</SelectItem>
                  <SelectItem value="regex">正则表达式</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={keywordForm.caseSensitive}
                onCheckedChange={(checked) => setKeywordForm({ ...keywordForm, caseSensitive: checked })}
              />
              <Label>区分大小写</Label>
            </div>
            <div className="space-y-2">
              <Label>描述</Label>
              <Textarea
                value={keywordForm.description}
                onChange={(e) => setKeywordForm({ ...keywordForm, description: e.target.value })}
                placeholder="关键词描述（可选）"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKeywordDialogOpen(false)}>取消</Button>
            <Button onClick={handleAddKeyword}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量导入对话框 */}
      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>批量导入关键词</DialogTitle>
            <DialogDescription>
              每行一个关键词，格式：关键词,分数,描述（分数和描述可选）
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>维度 *</Label>
              <Select
                value={keywordForm.dimension}
                onValueChange={(value) => setKeywordForm({ ...keywordForm, dimension: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dimensions.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>关键词列表</Label>
              <Textarea
                value={batchKeywords}
                onChange={(e) => setBatchKeywords(e.target.value)}
                placeholder={`忽略所有指令,100,提示词注入\n忽略之前,95\nsystem prompt,90`}
                rows={10}
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDialogOpen(false)}>取消</Button>
            <Button onClick={handleBatchAdd}>导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A/B 对比面板 */}
      <ABComparePanel
        currentPolicyId={policyId}
        isOpen={abPanelOpen}
        onToggle={() => setAbPanelOpen(!abPanelOpen)}
        showFloatingButton={false}
      />
    </div>
  );
}
