'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
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
import { toast } from 'sonner';
import {
  Plus,
  Shield,
  Trash2,
  Pencil,
  CheckCircle,
  AlertTriangle,
  TestTube,
  ChevronDown,
  ChevronRight,
  Play,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { csrfHeaders } from '@/lib/auth/csrf-client';

// 白名单规则类型
interface WhitelistRule {
  id: string;
  name: string;
  description?: string;
  policyScope: 'all' | 'specific';
  policyIds?: string[];
  policyNames?: string[];
  dimensionScope: 'all' | 'specific';
  dimensionCodes: string[];
  dimensionNames?: string[];
  priority: number;
  pattern: string;
  matchType: string;
  caseSensitive: boolean;
  enabled: boolean;
  createdAt?: string;
}

interface Dimension {
  id: string;
  code: string;
  name: string;
}

interface Policy {
  id: string;
  name: string;
  is_default?: boolean;
  isDefault?: boolean;
  isActive?: boolean;
}

// 测试结果类型
interface TestResult {
  matched: boolean;
  globalMatched: null | {
    id: string;
    name: string;
    pattern: string;
    matchType: string;
    effect: string;
  };
  dimensionMatched: Array<{
    id: string;
    name: string;
    pattern: string;
    matchType: string;
    dimensionCodes: string[];
    dimensionNames: string[];
    effect: string;
  }>;
  matchedButNotApplicable: Array<{
    id: string;
    name: string;
    reason: string;
  }>;
  skippedDimensions: Array<{
    code: string;
    name: string;
  }>;
  notAffectedDimensions: Array<{
    code: string;
    name: string;
  }>;
}

const matchTypeLabels: Record<string, string> = {
  contains: '包含',
  exact: '精确匹配',
  prefix: '前缀匹配',
  suffix: '后缀匹配',
  regex: '正则表达式',
};

export default function WhitelistPage() {
  const [rules, setRules] = useState<WhitelistRule[]>([]);
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<WhitelistRule | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // 表单数据
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    policyScope: 'all' as 'all' | 'specific',
    policyIds: [] as string[],
    dimensionScope: 'specific' as 'all' | 'specific',
    dimensionCodes: [] as string[],
    priority: 100,
    pattern: '',
    matchType: 'contains',
    caseSensitive: false,
    enabled: true,
  });

  // 测试表单
  const [testFormData, setTestFormData] = useState({
    policyId: '',
    text: '',
  });

  // 显示全局白名单风险提示
  const [showGlobalWarning, setShowGlobalWarning] = useState(false);

  const fetchData = async () => {
    try {
      const [rulesRes, dimensionsRes, policiesRes] = await Promise.all([
        fetch('/api/whitelist-rules'),
        fetch('/api/dimensions'),
        fetch('/api/policies'),
      ]);

      const rulesResult = await rulesRes.json();
      const dimensionsResult = await dimensionsRes.json();
      const policiesResult = await policiesRes.json();

      if (rulesResult.success) {
        setRules(rulesResult.data);
      }
      if (dimensionsResult.success) {
        setDimensions(dimensionsResult.data);
      }
      if (policiesResult.success && policiesResult.data?.length > 0) {
        // 只显示启用的策略
        const activePolicies = policiesResult.data.filter((p: Policy) => p.isActive);
        setPolicies(activePolicies);
        // 设置默认测试策略
        if (activePolicies.length > 0) {
          const defaultPolicy = activePolicies.find((p: Policy) => p.isDefault) || activePolicies[0];
          setTestFormData(prev => ({ ...prev, policyId: defaultPolicy.id }));
        }
      }
    } catch (error) {
      console.error('获取数据失败:', error);
      toast.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // 检查是否需要显示全局白名单风险提示
  useEffect(() => {
    if (formData.policyScope === 'all' && formData.dimensionScope === 'all') {
      setShowGlobalWarning(true);
    } else {
      setShowGlobalWarning(false);
    }
  }, [formData.policyScope, formData.dimensionScope]);

  // 按维度分组规则
  const groupedRules = rules.reduce((acc, rule) => {
    const key = rule.dimensionScope === 'all' ? '全局白名单' : rule.dimensionNames?.join('、') || '其他';
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(rule);
    return acc;
  }, {} as Record<string, WhitelistRule[]>);

  // 排序分组（全局白名单优先）
  const sortedGroups = Object.keys(groupedRules).sort((a, b) => {
    if (a === '全局白名单') return -1;
    if (b === '全局白名单') return 1;
    return a.localeCompare(b);
  });

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => ({
      ...prev,
      [group]: !prev[group],
    }));
  };

  // 重置表单
  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      policyScope: 'all',
      policyIds: [],
      dimensionScope: 'specific',
      dimensionCodes: [],
      priority: 100,
      pattern: '',
      matchType: 'contains',
      caseSensitive: false,
      enabled: true,
    });
  };

  // 创建白名单
  const handleCreate = async () => {
    // 校验
    if (!formData.name.trim()) {
      toast.error('请填写白名单名称');
      return;
    }
    if (!formData.pattern.trim()) {
      toast.error('请填写匹配内容');
      return;
    }
    if (formData.policyScope === 'specific' && formData.policyIds.length === 0) {
      toast.error('请选择至少一个策略');
      return;
    }
    if (formData.dimensionScope === 'specific' && formData.dimensionCodes.length === 0) {
      toast.error('请选择至少一个维度');
      return;
    }

    // 正则校验
    if (formData.matchType === 'regex') {
      try {
        new RegExp(formData.pattern);
      } catch {
        toast.error('正则表达式语法错误');
        return;
      }
    }

    // 全局白名单确认
    if (formData.policyScope === 'all' && formData.dimensionScope === 'all') {
      if (!confirm('全局白名单命中后会跳过所有检测，确定要创建吗？')) {
        return;
      }
    }

    try {
      const response = await fetch('/api/whitelist-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify(formData),
      });

      const result = await response.json();
      if (result.success) {
        toast.success('创建白名单规则成功');
        setCreateDialogOpen(false);
        resetForm();
        fetchData();
      } else {
        toast.error(result.error || '创建失败');
      }
    } catch (error) {
      console.error('创建白名单规则失败:', error);
      toast.error('创建白名单规则失败');
    }
  };

  // 编辑白名单
  const handleEdit = (rule: WhitelistRule) => {
    setEditingRule(rule);
    setFormData({
      name: rule.name || '',
      description: rule.description || '',
      policyScope: rule.policyScope,
      policyIds: rule.policyIds || [],
      dimensionScope: rule.dimensionScope,
      dimensionCodes: rule.dimensionCodes || [],
      priority: rule.priority || 100,
      pattern: rule.pattern,
      matchType: rule.matchType,
      caseSensitive: rule.caseSensitive,
      enabled: rule.enabled,
    });
    setEditDialogOpen(true);
  };

  // 更新白名单
  const handleUpdate = async () => {
    if (!editingRule) return;

    // 校验
    if (!formData.name.trim()) {
      toast.error('请填写白名单名称');
      return;
    }
    if (!formData.pattern.trim()) {
      toast.error('请填写匹配内容');
      return;
    }
    if (formData.policyScope === 'specific' && formData.policyIds.length === 0) {
      toast.error('请选择至少一个策略');
      return;
    }
    if (formData.dimensionScope === 'specific' && formData.dimensionCodes.length === 0) {
      toast.error('请选择至少一个维度');
      return;
    }

    // 正则校验
    if (formData.matchType === 'regex') {
      try {
        new RegExp(formData.pattern);
      } catch {
        toast.error('正则表达式语法错误');
        return;
      }
    }

    try {
      const response = await fetch('/api/whitelist-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          id: editingRule.id,
          ...formData,
        }),
      });

      const result = await response.json();
      if (result.success) {
        toast.success('更新成功');
        setEditDialogOpen(false);
        setEditingRule(null);
        resetForm();
        fetchData();
      } else {
        toast.error(result.error || '更新失败');
      }
    } catch (error) {
      console.error('更新白名单规则失败:', error);
      toast.error('更新白名单规则失败');
    }
  };

  // 切换启用状态
  const handleToggle = async (rule: WhitelistRule) => {
    try {
      const response = await fetch('/api/whitelist-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          ...rule,
          enabled: !rule.enabled,
        }),
      });

      const result = await response.json();
      if (result.success) {
        toast.success(rule.enabled ? '已禁用' : '已启用');
        fetchData();
      } else {
        toast.error(result.error || '操作失败');
      }
    } catch (error) {
      console.error('切换状态失败:', error);
      toast.error('操作失败');
    }
  };

  // 删除白名单
  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除该白名单规则吗？')) return;

    try {
      const response = await fetch(`/api/whitelist-rules?id=${id}`, {
        method: 'DELETE',
        headers: { ...csrfHeaders() },
      });

      const result = await response.json();
      if (result.success) {
        toast.success('删除成功');
        fetchData();
      } else {
        toast.error(result.error || '删除失败');
      }
    } catch (error) {
      console.error('删除白名单规则失败:', error);
      toast.error('删除白名单规则失败');
    }
  };

  // 测试白名单
  const handleTest = async () => {
    if (!testFormData.text.trim()) {
      toast.error('请输入测试文本');
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const response = await fetch('/api/whitelist-rules/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify(testFormData),
      });

      const result = await response.json();
      if (result.success) {
        setTestResult(result.data);
      } else {
        toast.error(result.error || '测试失败');
      }
    } catch (error) {
      console.error('测试白名单失败:', error);
      toast.error('测试白名单失败');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-gray-100"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-7xl">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">白名单规则管理</h1>
          <p className="text-muted-foreground mt-2">
            配置白名单规则，命中后跳过指定维度检测或全部检测
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setTestDialogOpen(true)}>
            <TestTube className="h-4 w-4 mr-2" />
            测试白名单
          </Button>
          <Button onClick={() => { resetForm(); setCreateDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" />
            新建规则
          </Button>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{rules.length}</div>
            <p className="text-sm text-muted-foreground">总规则数</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-green-600">
              {rules.filter(r => r.enabled).length}
            </div>
            <p className="text-sm text-muted-foreground">已启用</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-blue-600">
              {rules.filter(r => r.dimensionScope === 'all').length}
            </div>
            <p className="text-sm text-muted-foreground">全局白名单</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-purple-600">
              {rules.filter(r => r.dimensionScope === 'specific').length}
            </div>
            <p className="text-sm text-muted-foreground">维度白名单</p>
          </CardContent>
        </Card>
      </div>

      {/* 按维度分组展示 */}
      {sortedGroups.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            暂无白名单规则，点击&quot;新建规则&quot;创建
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sortedGroups.map((group) => (
            <Card key={group}>
              <CardHeader
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => toggleGroup(group)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {expandedGroups[group] !== false ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    <CardTitle className="text-lg flex items-center gap-2">
                      {group === '全局白名单' ? (
                        <Shield className="h-5 w-5 text-blue-500" />
                      ) : (
                        <CheckCircle className="h-5 w-5 text-green-500" />
                      )}
                      {group}
                    </CardTitle>
                    <Badge variant="secondary">{groupedRules[group].length}</Badge>
                  </div>
                  {group === '全局白名单' && (
                    <Badge variant="destructive">高风险</Badge>
                  )}
                </div>
              </CardHeader>
              {expandedGroups[group] !== false && (
                <CardContent>
                  <div className="space-y-3">
                    {groupedRules[group]
                      .sort((a, b) => b.priority - a.priority)
                      .map((rule) => (
                        <div
                          key={rule.id}
                          className="flex items-start justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                        >
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="font-medium">{rule.name}</span>
                              <Badge variant="outline">{matchTypeLabels[rule.matchType]}</Badge>
                              <Badge variant={rule.enabled ? 'default' : 'secondary'}>
                                {rule.enabled ? '已启用' : '已禁用'}
                              </Badge>
                              {rule.dimensionScope === 'all' && (
                                <Badge variant="destructive">全部维度</Badge>
                              )}
                              <Badge variant="outline">优先级: {rule.priority}</Badge>
                            </div>
                            <div className="flex items-center gap-2 mb-2">
                              <code className="text-sm bg-muted px-2 py-0.5 rounded">
                                {rule.pattern}
                              </code>
                            </div>
                            <div className="text-sm text-muted-foreground space-y-1">
                              <div>
                                适用策略: {rule.policyScope === 'all' ? '全部策略' : rule.policyNames?.join('、')}
                              </div>
                              <div>
                                适用维度: {rule.dimensionScope === 'all' ? '全部维度' : rule.dimensionNames?.join('、')}
                              </div>
                              {rule.description && (
                                <div className="text-xs">{rule.description}</div>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <Switch
                              checked={rule.enabled}
                              onCheckedChange={() => handleToggle(rule)}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              title="编辑"
                              onClick={() => handleEdit(rule)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="删除"
                              onClick={() => handleDelete(rule.id)}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </div>
                      ))}
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* 创建对话框 */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>创建白名单规则</DialogTitle>
            <DialogDescription>
              配置白名单规则，命中后可跳过指定维度的检测
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* 全局白名单风险提示 */}
            {showGlobalWarning && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>高风险配置</AlertTitle>
                <AlertDescription>
                  全局白名单（全部策略 + 全部维度）命中后会跳过所有检测，请谨慎使用。
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">白名单名称 *</Label>
                <Input
                  id="name"
                  placeholder="例如：安全教育白名单"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="priority">优先级</Label>
                <Input
                  id="priority"
                  type="number"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 100 })}
                />
                <p className="text-xs text-muted-foreground">数值越大优先级越高</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">描述</Label>
              <Textarea
                id="description"
                placeholder="白名单用途说明..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>匹配内容 *</Label>
              <Input
                placeholder="例如：安全教育"
                value={formData.pattern}
                onChange={(e) => setFormData({ ...formData, pattern: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>匹配方式</Label>
                <Select
                  value={formData.matchType}
                  onValueChange={(value) => setFormData({ ...formData, matchType: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择匹配方式" />
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
              <div className="flex items-end gap-2 pb-2">
                <Checkbox
                  id="caseSensitive"
                  checked={formData.caseSensitive}
                  onCheckedChange={(checked) => setFormData({ ...formData, caseSensitive: !!checked })}
                />
                <Label htmlFor="caseSensitive" className="text-sm font-normal">
                  区分大小写
                </Label>
              </div>
            </div>

            <div className="border-t pt-4">
              <h4 className="font-medium mb-3">适用策略</h4>
              <div className="flex gap-4 mb-3">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="policyAll"
                    name="policyScope"
                    checked={formData.policyScope === 'all'}
                    onChange={() => setFormData({ ...formData, policyScope: 'all', policyIds: [] })}
                  />
                  <Label htmlFor="policyAll">全部策略</Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="policySpecific"
                    name="policyScope"
                    checked={formData.policyScope === 'specific'}
                    onChange={() => setFormData({ ...formData, policyScope: 'specific' })}
                  />
                  <Label htmlFor="policySpecific">指定策略</Label>
                </div>
              </div>
              {formData.policyScope === 'specific' && (
                <div className="grid grid-cols-2 gap-2 p-3 bg-muted rounded-lg">
                  {policies.map((policy) => (
                    <div key={policy.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`policy-${policy.id}`}
                        checked={formData.policyIds.includes(policy.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setFormData({ ...formData, policyIds: [...formData.policyIds, policy.id] });
                          } else {
                            setFormData({ ...formData, policyIds: formData.policyIds.filter(id => id !== policy.id) });
                          }
                        }}
                      />
                      <Label htmlFor={`policy-${policy.id}`} className="text-sm font-normal">
                        {policy.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t pt-4">
              <h4 className="font-medium mb-3">适用维度</h4>
              <div className="flex gap-4 mb-3">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="dimensionAll"
                    name="dimensionScope"
                    checked={formData.dimensionScope === 'all'}
                    onChange={() => setFormData({ ...formData, dimensionScope: 'all', dimensionCodes: [] })}
                  />
                  <Label htmlFor="dimensionAll">全部维度</Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="dimensionSpecific"
                    name="dimensionScope"
                    checked={formData.dimensionScope === 'specific'}
                    onChange={() => setFormData({ ...formData, dimensionScope: 'specific' })}
                  />
                  <Label htmlFor="dimensionSpecific">指定维度</Label>
                </div>
              </div>
              {formData.dimensionScope === 'specific' && (
                <div className="grid grid-cols-2 gap-2 p-3 bg-muted rounded-lg max-h-48 overflow-y-auto">
                  {dimensions.map((dim) => (
                    <div key={dim.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`dim-${dim.id}`}
                        checked={formData.dimensionCodes.includes(dim.code)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setFormData({ ...formData, dimensionCodes: [...formData.dimensionCodes, dim.code] });
                          } else {
                            setFormData({ ...formData, dimensionCodes: formData.dimensionCodes.filter(code => code !== dim.code) });
                          }
                        }}
                      />
                      <Label htmlFor={`dim-${dim.id}`} className="text-sm font-normal">
                        {dim.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="enabled"
                checked={formData.enabled}
                onCheckedChange={(checked) => setFormData({ ...formData, enabled: checked })}
              />
              <Label htmlFor="enabled" className="text-sm font-normal">
                启用该规则
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreate}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑对话框 */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑白名单规则</DialogTitle>
            <DialogDescription>
              修改白名单规则配置
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* 同上创建表单 */}
            {showGlobalWarning && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>高风险配置</AlertTitle>
                <AlertDescription>
                  全局白名单（全部策略 + 全部维度）命中后会跳过所有检测，请谨慎使用。
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">白名单名称 *</Label>
                <Input
                  id="edit-name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-priority">优先级</Label>
                <Input
                  id="edit-priority"
                  type="number"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 100 })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-description">描述</Label>
              <Textarea
                id="edit-description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label>匹配内容 *</Label>
              <Input
                value={formData.pattern}
                onChange={(e) => setFormData({ ...formData, pattern: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>匹配方式</Label>
                <Select
                  value={formData.matchType}
                  onValueChange={(value) => setFormData({ ...formData, matchType: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
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
              <div className="flex items-end gap-2 pb-2">
                <Checkbox
                  id="edit-caseSensitive"
                  checked={formData.caseSensitive}
                  onCheckedChange={(checked) => setFormData({ ...formData, caseSensitive: !!checked })}
                />
                <Label htmlFor="edit-caseSensitive" className="text-sm font-normal">
                  区分大小写
                </Label>
              </div>
            </div>

            <div className="border-t pt-4">
              <h4 className="font-medium mb-3">适用策略</h4>
              <div className="flex gap-4 mb-3">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="edit-policyAll"
                    name="edit-policyScope"
                    checked={formData.policyScope === 'all'}
                    onChange={() => setFormData({ ...formData, policyScope: 'all', policyIds: [] })}
                  />
                  <Label htmlFor="edit-policyAll">全部策略</Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="edit-policySpecific"
                    name="edit-policyScope"
                    checked={formData.policyScope === 'specific'}
                    onChange={() => setFormData({ ...formData, policyScope: 'specific' })}
                  />
                  <Label htmlFor="edit-policySpecific">指定策略</Label>
                </div>
              </div>
              {formData.policyScope === 'specific' && (
                <div className="grid grid-cols-2 gap-2 p-3 bg-muted rounded-lg">
                  {policies.map((policy) => (
                    <div key={policy.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`edit-policy-${policy.id}`}
                        checked={formData.policyIds.includes(policy.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setFormData({ ...formData, policyIds: [...formData.policyIds, policy.id] });
                          } else {
                            setFormData({ ...formData, policyIds: formData.policyIds.filter(id => id !== policy.id) });
                          }
                        }}
                      />
                      <Label htmlFor={`edit-policy-${policy.id}`} className="text-sm font-normal">
                        {policy.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t pt-4">
              <h4 className="font-medium mb-3">适用维度</h4>
              <div className="flex gap-4 mb-3">
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="edit-dimensionAll"
                    name="edit-dimensionScope"
                    checked={formData.dimensionScope === 'all'}
                    onChange={() => setFormData({ ...formData, dimensionScope: 'all', dimensionCodes: [] })}
                  />
                  <Label htmlFor="edit-dimensionAll">全部维度</Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    id="edit-dimensionSpecific"
                    name="edit-dimensionScope"
                    checked={formData.dimensionScope === 'specific'}
                    onChange={() => setFormData({ ...formData, dimensionScope: 'specific' })}
                  />
                  <Label htmlFor="edit-dimensionSpecific">指定维度</Label>
                </div>
              </div>
              {formData.dimensionScope === 'specific' && (
                <div className="grid grid-cols-2 gap-2 p-3 bg-muted rounded-lg max-h-48 overflow-y-auto">
                  {dimensions.map((dim) => (
                    <div key={dim.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`edit-dim-${dim.id}`}
                        checked={formData.dimensionCodes.includes(dim.code)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setFormData({ ...formData, dimensionCodes: [...formData.dimensionCodes, dim.code] });
                          } else {
                            setFormData({ ...formData, dimensionCodes: formData.dimensionCodes.filter(code => code !== dim.code) });
                          }
                        }}
                      />
                      <Label htmlFor={`edit-dim-${dim.id}`} className="text-sm font-normal">
                        {dim.name}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="edit-enabled"
                checked={formData.enabled}
                onCheckedChange={(checked) => setFormData({ ...formData, enabled: checked })}
              />
              <Label htmlFor="edit-enabled" className="text-sm font-normal">
                启用该规则
              </Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleUpdate}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 测试对话框 */}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>测试白名单</DialogTitle>
            <DialogDescription>
              输入测试文本，查看白名单匹配情况
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>测试策略</Label>
              <Select
                value={testFormData.policyId}
                onValueChange={(value) => setTestFormData({ ...testFormData, policyId: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择策略" />
                </SelectTrigger>
                <SelectContent>
                  {policies.map((policy) => (
                    <SelectItem key={policy.id} value={policy.id}>
                      {policy.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>测试文本</Label>
              <Textarea
                placeholder="输入要测试的文本内容..."
                value={testFormData.text}
                onChange={(e) => setTestFormData({ ...testFormData, text: e.target.value })}
                rows={4}
              />
            </div>

            <Button onClick={handleTest} disabled={testing}>
              <Play className="h-4 w-4 mr-2" />
              {testing ? '测试中...' : '开始测试'}
            </Button>

            {testResult && (
              <div className="border rounded-lg p-4 space-y-4">
                <div className="flex items-center gap-2">
                  {testResult.matched ? (
                    <Badge className="bg-green-500">命中白名单</Badge>
                  ) : (
                    <Badge variant="secondary">未命中白名单</Badge>
                  )}
                </div>

                {testResult.globalMatched && (
                  <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg">
                    <div className="font-medium text-blue-700 dark:text-blue-400 mb-2">
                      命中全局白名单
                    </div>
                    <div className="text-sm">
                      <div>名称: {testResult.globalMatched.name}</div>
                      <div>匹配内容: {testResult.globalMatched.pattern}</div>
                      <div>效果: {testResult.globalMatched.effect}</div>
                    </div>
                  </div>
                )}

                {testResult.dimensionMatched.length > 0 && (
                  <div className="bg-purple-50 dark:bg-purple-900/20 p-3 rounded-lg">
                    <div className="font-medium text-purple-700 dark:text-purple-400 mb-2">
                      命中维度白名单
                    </div>
                    {testResult.dimensionMatched.map((m, i) => (
                      <div key={i} className="text-sm mb-2">
                        <div>名称: {m.name}</div>
                        <div>匹配内容: {m.pattern}</div>
                        <div>效果: {m.effect}</div>
                      </div>
                    ))}
                  </div>
                )}

                {testResult.matchedButNotApplicable.length > 0 && (
                  <div className="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded-lg">
                    <div className="font-medium text-yellow-700 dark:text-yellow-400 mb-2">
                      匹配但不生效
                    </div>
                    {testResult.matchedButNotApplicable.map((m, i) => (
                      <div key={i} className="text-sm">
                        <div>{m.name}: {m.reason}</div>
                      </div>
                    ))}
                  </div>
                )}

                {testResult.skippedDimensions.length > 0 && (
                  <div>
                    <div className="font-medium mb-2">会跳过的维度:</div>
                    <div className="flex flex-wrap gap-2">
                      {testResult.skippedDimensions.map((d, i) => (
                        <Badge key={i} variant="outline">{d.name}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {testResult.notAffectedDimensions.length > 0 && (
                  <div>
                    <div className="font-medium mb-2">不会影响的维度:</div>
                    <div className="flex flex-wrap gap-2">
                      {testResult.notAffectedDimensions.map((d, i) => (
                        <Badge key={i} variant="secondary">{d.name}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setTestDialogOpen(false); setTestResult(null); }}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
