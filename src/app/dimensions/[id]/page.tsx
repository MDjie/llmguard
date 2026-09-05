'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Edit,
  Play,
  Loader2,
  Pencil,
} from 'lucide-react';

interface Dimension {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  weight: string;
  priority: number;
  enabled: boolean;
  isSystem: boolean;
  config: Record<string, unknown>;
}

interface Rule {
  id: string;
  dimensionId: string;
  groupId: string | null;
  name: string;
  type: string;
  pattern: string | null;
  matchType: string;
  caseSensitive: boolean;
  score: string;
  confidence: string;
  priority: number;
  enabled: boolean;
  description: string | null;
  config: Record<string, unknown>;
  tags: string[];
  groupName?: string;
  suggestion?: string | null;
}

interface MatchedTestRule {
  id: string;
  name: string;
  type?: string;
  pattern?: string | null;
  score?: string | number;
  confidence?: string | number;
  matches?: string[];
}

interface DimensionTestResult {
  score: number;
  matchedCount: number;
  ruleCount: number;
  matchedRules: MatchedTestRule[];
  evidence?: string[];
}

const RULE_TYPE_LABEL: Record<string, string> = {
  keyword: '关键词',
  regex: '正则表达式',
  semantic: '语义分析',
  llm: 'LLM 判断',
};

const MATCH_TYPE_LABEL: Record<string, string> = {
  contains: '包含',
  exact: '精确匹配',
  prefix: '前缀匹配',
  suffix: '后缀匹配',
  regex: '正则表达式',
};

// 接口返回的是 detection_rules 原始行(蛇形命名 match_type/case_sensitive...),
// 这里统一映射成前端 Rule 形状,避免读取 matchType/caseSensitive 等字段为空。
function mapRuleRow(row: Record<string, unknown>): Rule {
  return {
    id: String(row.id ?? ''),
    dimensionId: String(row.dimension_id ?? ''),
    groupId: row.group_id ? String(row.group_id) : null,
    name: String(row.name ?? ''),
    type: String(row.type ?? ''),
    pattern: row.pattern != null ? String(row.pattern) : null,
    matchType: row.match_type ? String(row.match_type) : 'contains',
    caseSensitive: Boolean(row.case_sensitive),
    score: String(row.score ?? '0'),
    confidence: String(row.confidence ?? '0'),
    priority: Number(row.priority ?? 100),
    enabled: Boolean(row.enabled),
    description: row.description != null ? String(row.description) : null,
    config: (row.config && typeof row.config === 'object' ? row.config : {}) as Record<string, unknown>,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    groupName: row.group_name ? String(row.group_name) : undefined,
    suggestion: row.suggestion != null ? String(row.suggestion) : null,
  };
}

function testSeverity(score: number): { label: string; variant: 'destructive' | 'secondary' | 'outline' | 'default'; textColor: string } {
  if (score >= 70) return { label: '高风险', variant: 'destructive', textColor: 'text-red-600' };
  if (score >= 40) return { label: '中风险', variant: 'secondary', textColor: 'text-amber-600' };
  if (score > 0) return { label: '低风险', variant: 'secondary', textColor: 'text-yellow-600' };
  return { label: '未命中', variant: 'outline', textColor: 'text-green-600' };
}

export default function DimensionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const dimensionId = params.id as string;

  const [dimension, setDimension] = useState<Dimension | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [createRuleOpen, setCreateRuleOpen] = useState(false);
  const [editRuleOpen, setEditRuleOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<DimensionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const [ruleForm, setRuleForm] = useState({
    name: '',
    type: 'keyword',
    pattern: '',
    matchType: 'contains',
    caseSensitive: false,
    score: '50',
    confidence: '0.8',
    priority: '100',
    description: '',
    suggestion: '',
  });

  const fetchDimension = async () => {
    try {
      const response = await fetch(`/api/dimensions/${dimensionId}`);
      const result = await response.json();
      if (result.success) {
        setDimension(result.data);
        const rawRules: Record<string, unknown>[] = Array.isArray(result.data.rules)
          ? result.data.rules
          : [];
        setRules(rawRules.map(mapRuleRow));
      }
    } catch (error) {
      console.error('获取维度详情失败:', error);
      toast.error('获取维度详情失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDimension();
  }, [dimensionId]);

  const handleCreateRule = async () => {
    if (!ruleForm.name || !ruleForm.type) {
      toast.error('请填写规则名称和类型');
      return;
    }

    if ((ruleForm.type === 'keyword' || ruleForm.type === 'regex') && !ruleForm.pattern) {
      toast.error('关键词和正则规则需要提供匹配模式');
      return;
    }

    try {
      const response = await fetch(`/api/dimensions/${dimensionId}/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          ...ruleForm,
          score: parseFloat(ruleForm.score),
          confidence: parseFloat(ruleForm.confidence),
          priority: parseInt(ruleForm.priority),
        }),
      });

      const result = await response.json();
      if (result.success) {
        toast.success('创建规则成功');
        setCreateRuleOpen(false);
        setRuleForm({
          name: '',
          type: 'keyword',
          pattern: '',
          matchType: 'contains',
          caseSensitive: false,
          score: '50',
          confidence: '0.8',
          priority: '100',
          description: '',
          suggestion: '',
        });
        fetchDimension();
      } else {
        toast.error(result.error || '创建失败');
      }
    } catch (error) {
      console.error('创建规则失败:', error);
      toast.error('创建规则失败');
    }
  };

  const openEditDialog = (rule: Rule) => {
    setEditingRule(rule);
    setRuleForm({
      name: rule.name,
      type: rule.type,
      pattern: rule.pattern || '',
      matchType: rule.matchType,
      caseSensitive: rule.caseSensitive,
      score: String(rule.score),
      confidence: String(rule.confidence),
      priority: String(rule.priority),
      description: rule.description || '',
      suggestion: rule.suggestion || '',
    });
    setEditRuleOpen(true);
  };

  const handleEditRule = async () => {
    if (!editingRule || !ruleForm.name || !ruleForm.type) {
      toast.error('请填写规则名称和类型');
      return;
    }

    if ((ruleForm.type === 'keyword' || ruleForm.type === 'regex') && !ruleForm.pattern) {
      toast.error('关键词和正则规则需要提供匹配模式');
      return;
    }

    try {
      const response = await fetch(`/api/dimensions/${dimensionId}/rules/${editingRule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          ...ruleForm,
          score: parseFloat(ruleForm.score),
          confidence: parseFloat(ruleForm.confidence),
          priority: parseInt(ruleForm.priority),
        }),
      });

      const result = await response.json();
      if (result.success) {
        toast.success('更新规则成功');
        setEditRuleOpen(false);
        setEditingRule(null);
        setRuleForm({
          name: '',
          type: 'keyword',
          pattern: '',
          matchType: 'contains',
          caseSensitive: false,
          score: '50',
          confidence: '0.8',
          priority: '100',
          description: '',
          suggestion: '',
        });
        fetchDimension();
      } else {
        toast.error(result.error || '更新失败');
      }
    } catch (error) {
      console.error('更新规则失败:', error);
      toast.error('更新规则失败');
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('确定要删除该规则吗？')) return;

    try {
      const response = await fetch(`/api/dimensions/${dimensionId}/rules/${ruleId}`, {
        method: 'DELETE',
        headers: { ...csrfHeaders() },
      });

      const result = await response.json();
      if (result.success) {
        toast.success('删除成功');
        fetchDimension();
      } else {
        toast.error(result.error || '删除失败');
      }
    } catch (error) {
      console.error('删除规则失败:', error);
      toast.error('删除规则失败');
    }
  };

  const handleTest = async () => {
    if (!testText.trim()) {
      toast.error('请输入测试文本');
      return;
    }

    setTesting(true);
    try {
      const response = await fetch(`/api/dimensions/${dimensionId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ text: testText }),
      });

      const result = await response.json();
      if (result.success) {
        // 后端返回结构:score / matchedCount / ruleCount / matchedRules[] / evidence[],
        // 与旧版 totalRules/matches 不同,这里统一做一次归一化,避免渲染崩溃。
        const data = result.data ?? {};
        const matchedRules: MatchedTestRule[] = Array.isArray(data.matchedRules) ? data.matchedRules : [];
        setTestResult({
          score: Number(data.score) || 0,
          matchedCount: Number(data.matchedCount ?? matchedRules.length) || 0,
          ruleCount: Number(data.ruleCount ?? data.totalRules) || 0,
          matchedRules,
          evidence: Array.isArray(data.evidence) ? data.evidence : [],
        });
      } else {
        toast.error(result.error || '测试失败');
      }
    } catch (error) {
      console.error('测试失败:', error);
      toast.error('测试失败');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  if (!dimension) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="text-center py-12">
          <p className="text-muted-foreground">维度不存在</p>
          <Button className="mt-4" onClick={() => router.push('/dimensions')}>
            返回列表
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-7xl">
      {/* 头部 */}
      <div className="flex items-center gap-4 mb-8">
        <Button variant="ghost" onClick={() => router.push('/dimensions')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          返回
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{dimension.name}</h1>
          <p className="text-muted-foreground mt-1">
            {dimension.code} · {dimension.description || '暂无描述'}
          </p>
        </div>
        <Button onClick={() => setTestDialogOpen(true)}>
          <Play className="h-4 w-4 mr-2" />
          测试维度
        </Button>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="rules" className="space-y-6">
        <TabsList>
          <TabsTrigger value="rules">检测规则</TabsTrigger>
          <TabsTrigger value="settings">基本设置</TabsTrigger>
        </TabsList>

        <TabsContent value="rules">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>检测规则</CardTitle>
                  <CardDescription>
                    管理该维度的检测规则，支持关键词、正则表达式、语义分析等
                  </CardDescription>
                </div>
                <Button onClick={() => setCreateRuleOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  新建规则
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>规则名称</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>匹配模式</TableHead>
                    <TableHead>分数</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-[100px]">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        暂无规则，点击上方按钮创建
                      </TableCell>
                    </TableRow>
                  ) : (
                    rules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{rule.name}</p>
                            {rule.description && (
                              <p className="text-xs text-muted-foreground">{rule.description}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {rule.type === 'keyword' ? '关键词' :
                             rule.type === 'regex' ? '正则表达式' :
                             rule.type === 'semantic' ? '语义分析' : 'LLM'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs">
                            {MATCH_TYPE_LABEL[rule.matchType] ?? rule.matchType ?? '-'}
                          </Badge>
                        </TableCell>
                        <TableCell>{rule.score}</TableCell>
                        <TableCell>
                          <Badge variant={rule.enabled ? 'default' : 'secondary'}>
                            {rule.enabled ? '启用' : '禁用'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditDialog(rule)}
                            >
                              <Pencil className="h-4 w-4 text-blue-500" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteRule(rule.id)}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings">
          <Card>
            <CardHeader>
              <CardTitle>基本设置</CardTitle>
              <CardDescription>维度的基本信息和配置</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>维度编码</Label>
                  <Input value={dimension.code} disabled />
                </div>
                <div>
                  <Label>维度名称</Label>
                  <Input value={dimension.name} disabled />
                </div>
              </div>
              <div>
                <Label>描述</Label>
                <Textarea value={dimension.description || ''} disabled />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label>分类</Label>
                  <Input value={dimension.category || '-'} disabled />
                </div>
                <div>
                  <Label>权重</Label>
                  <Input value={dimension.weight} disabled />
                </div>
                <div>
                  <Label>优先级</Label>
                  <Input value={dimension.priority} disabled />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 创建规则对话框 */}
      <Dialog open={createRuleOpen} onOpenChange={setCreateRuleOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>创建检测规则</DialogTitle>
            <DialogDescription>
              为该维度添加新的检测规则
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>规则名称</Label>
              <Input
                placeholder="例如：SQL注入检测"
                value={ruleForm.name}
                onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>规则类型</Label>
              <Select
                value={ruleForm.type}
                onValueChange={(value) => setRuleForm({ ...ruleForm, type: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keyword">关键词匹配</SelectItem>
                  <SelectItem value="regex">正则表达式</SelectItem>
                  <SelectItem value="semantic">语义分析</SelectItem>
                  <SelectItem value="llm">LLM检测</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(ruleForm.type === 'keyword' || ruleForm.type === 'regex') && (
              <div className="space-y-2">
                <Label>匹配模式</Label>
                <Input
                  placeholder={ruleForm.type === 'regex' ? '正则表达式' : '关键词'}
                  value={ruleForm.pattern}
                  onChange={(e) => setRuleForm({ ...ruleForm, pattern: e.target.value })}
                />
              </div>
            )}

            {ruleForm.type === 'keyword' && (
              <div className="space-y-2">
                <Label>匹配方式</Label>
                <Select
                  value={ruleForm.matchType}
                  onValueChange={(value) => setRuleForm({ ...ruleForm, matchType: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">包含</SelectItem>
                    <SelectItem value="exact">精确匹配</SelectItem>
                    <SelectItem value="prefix">前缀匹配</SelectItem>
                    <SelectItem value="suffix">后缀匹配</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>风险分数 (0-100)</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={ruleForm.score}
                  onChange={(e) => setRuleForm({ ...ruleForm, score: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>置信度 (0-1)</Label>
                <Input
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={ruleForm.confidence}
                  onChange={(e) => setRuleForm({ ...ruleForm, confidence: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                checked={ruleForm.caseSensitive}
                onCheckedChange={(checked) => setRuleForm({ ...ruleForm, caseSensitive: checked })}
              />
              <Label>区分大小写</Label>
            </div>

            <div className="space-y-2">
              <Label>描述</Label>
              <Textarea
                placeholder="规则描述..."
                value={ruleForm.description}
                onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>修复建议</Label>
              <Textarea
                placeholder="命中此规则后的修复建议..."
                value={ruleForm.suggestion}
                onChange={(e) => setRuleForm({ ...ruleForm, suggestion: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                当检测命中此规则时，会向用户展示此建议
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateRuleOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreateRule}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑规则对话框 */}
      <Dialog open={editRuleOpen} onOpenChange={setEditRuleOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑规则</DialogTitle>
            <DialogDescription>
              修改检测规则配置
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>规则名称 *</Label>
                <Input
                  placeholder="规则名称"
                  value={ruleForm.name}
                  onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>规则类型 *</Label>
                <Select value={ruleForm.type} onValueChange={(v) => setRuleForm({ ...ruleForm, type: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择类型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keyword">关键词匹配</SelectItem>
                    <SelectItem value="regex">正则表达式</SelectItem>
                    <SelectItem value="semantic">语义检测</SelectItem>
                    <SelectItem value="llm">LLM判断</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>匹配模式</Label>
                <Select value={ruleForm.matchType} onValueChange={(v) => setRuleForm({ ...ruleForm, matchType: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择匹配模式" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">包含</SelectItem>
                    <SelectItem value="exact">精确匹配</SelectItem>
                    <SelectItem value="prefix">前缀匹配</SelectItem>
                    <SelectItem value="suffix">后缀匹配</SelectItem>
                    <SelectItem value="regex">正则表达式</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>优先级</Label>
                <Input
                  type="number"
                  placeholder="100"
                  value={ruleForm.priority}
                  onChange={(e) => setRuleForm({ ...ruleForm, priority: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>匹配内容</Label>
              <Textarea
                placeholder="关键词或正则表达式..."
                value={ruleForm.pattern}
                onChange={(e) => setRuleForm({ ...ruleForm, pattern: e.target.value })}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                多个关键词用换行分隔，每行一个关键词
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>风险分数 (0-100)</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={ruleForm.score}
                  onChange={(e) => setRuleForm({ ...ruleForm, score: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>置信度 (0-1)</Label>
                <Input
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={ruleForm.confidence}
                  onChange={(e) => setRuleForm({ ...ruleForm, confidence: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                checked={ruleForm.caseSensitive}
                onCheckedChange={(checked) => setRuleForm({ ...ruleForm, caseSensitive: checked })}
              />
              <Label>区分大小写</Label>
            </div>

            <div className="space-y-2">
              <Label>描述</Label>
              <Textarea
                placeholder="规则描述..."
                value={ruleForm.description}
                onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>修复建议</Label>
              <Textarea
                placeholder="命中此规则后的修复建议..."
                value={ruleForm.suggestion}
                onChange={(e) => setRuleForm({ ...ruleForm, suggestion: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                当检测命中此规则时，会向用户展示此建议
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRuleOpen(false)}>
              取消
            </Button>
            <Button onClick={handleEditRule}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 测试对话框 */}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>测试维度检测</DialogTitle>
            <DialogDescription>
              输入文本测试该维度的检测效果
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>测试文本</Label>
              <Textarea
                placeholder="输入要测试的文本..."
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                rows={4}
              />
            </div>

            <Button onClick={handleTest} disabled={testing}>
              {testing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  测试中...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  开始测试
                </>
              )}
            </Button>

            {testResult && (
              <div className="space-y-4 mt-4 border-t pt-4">
                {/* 汇总:风险分 + 命中统计 */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm text-muted-foreground">风险分</span>
                    <span className={`text-3xl font-bold ${testSeverity(testResult.score).textColor}`}>
                      {testResult.score}
                    </span>
                    <Badge variant={testSeverity(testResult.score).variant}>
                      {testSeverity(testResult.score).label}
                    </Badge>
                  </div>
                  <Badge variant="outline" className="text-base">
                    命中 {testResult.matchedCount} / {testResult.ruleCount || testResult.matchedRules.length} 条规则
                  </Badge>
                </div>

                {testResult.matchedRules.length > 0 && (
                  <div className="space-y-2">
                    <Label>命中的规则</Label>
                    <div className="space-y-2">
                      {testResult.matchedRules.map((rule) => (
                        <div
                          key={rule.id}
                          className="flex items-start justify-between gap-3 p-3 rounded border bg-muted/40"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium">{rule.name}</p>
                              <Badge variant="secondary" className="text-xs">
                                {RULE_TYPE_LABEL[rule.type ?? ''] ?? rule.type ?? '规则'}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1 break-all">
                              命中内容: {rule.matches?.length ? rule.matches.join('、') : rule.pattern || '-'}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge variant="outline">分数 {rule.score ?? '-'}</Badge>
                            <Badge variant="outline">置信度 {rule.confidence ?? '-'}</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {testResult.evidence && testResult.evidence.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    匹配文本片段: {testResult.evidence.join('、')}
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setTestDialogOpen(false);
              setTestResult(null);
              setTestText('');
            }}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
