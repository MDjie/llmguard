'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/console/page-header';
import { MetricCard } from '@/components/console/metric-card';
import { EmptyState } from '@/components/console/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import {
  Plus,
  Search,
  Layers,
  CheckCircle2,
  BookOpenCheck,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
  StarOff,
  Settings,
  FileText,
  Shield,
} from 'lucide-react';

interface Policy {
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
  }>;
  stats: {
    totalRules: number;
    totalDimensions: number;
    configuredDimensions: number;
    totalKeywords: number;
    totalCategories: number;
  };
  createdAt: string;
  updatedAt: string | null;
}

interface Dimension {
  id: string;
  code: string;
  name: string;
  description: string;
  category: string;
  weight: number;
  enabled: boolean;
  is_system: boolean;
}

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dimensionFilter, setDimensionFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    tags: '',
    cloneFrom: '',
  });

  // 加载维度列表
  const loadDimensions = async () => {
    try {
      const response = await fetch('/api/dimensions');
      const data = await response.json();
      if (data.success) {
        setDimensions(data.data);
      }
    } catch (error) {
      console.error('加载维度失败:', error);
    }
  };

  // 加载策略列表
  const loadPolicies = async () => {
    try {
      const res = await fetch('/api/policies');
      const data = await res.json();
      if (data.success) {
        setPolicies(data.data);
      }
    } catch (error) {
      console.error('加载策略失败:', error);
      toast.error('加载失败: 无法加载策略列表');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPolicies();
    loadDimensions();
  }, []);

  // 创建策略
  const handleCreate = async () => {
    if (!formData.name.trim()) {
      toast.error('策略名称不能为空');
      return;
    }

    try {
      const res = await fetch('/api/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description,
          tags: formData.tags.split(',').map((t) => t.trim()).filter(Boolean),
          cloneFrom: formData.cloneFrom || undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        toast.success('策略创建成功');
        setCreateDialogOpen(false);
        setFormData({ name: '', description: '', tags: '', cloneFrom: '' });
        loadPolicies();
      } else {
        toast.error('创建失败: ' + data.error);
      }
    } catch {
      toast.error('创建失败: 网络错误');
    }
  };

  // 克隆策略
  const handleClone = async () => {
    if (!selectedPolicy || !formData.name.trim()) {
      toast.error('请输入新策略名称');
      return;
    }

    try {
      const res = await fetch(`/api/policies/${selectedPolicy.id}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ name: formData.name }),
      });

      const data = await res.json();
      if (data.success) {
        toast.success('策略克隆成功');
        setCloneDialogOpen(false);
        setSelectedPolicy(null);
        setFormData({ name: '', description: '', tags: '', cloneFrom: '' });
        loadPolicies();
      } else {
        toast.error('克隆失败: ' + data.error);
      }
    } catch {
      toast.error('克隆失败: 网络错误');
    }
  };

  // 编辑策略
  const handleEdit = async () => {
    if (!selectedPolicy || !formData.name.trim()) {
      toast.error('策略名称不能为空');
      return;
    }

    try {
      const res = await fetch(`/api/policies/${selectedPolicy.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description,
          tags: formData.tags.split(',').map((t) => t.trim()).filter(Boolean),
        }),
      });

      const data = await res.json();
      if (data.success) {
        toast.success('策略更新成功');
        setEditDialogOpen(false);
        setSelectedPolicy(null);
        loadPolicies();
      } else {
        toast.error('更新失败: ' + data.error);
      }
    } catch {
      toast.error('更新失败: 网络错误');
    }
  };

  // 删除策略
  const handleDelete = async () => {
    if (!selectedPolicy) return;

    try {
      const res = await fetch(`/api/policies?id=${selectedPolicy.id}`, {
        method: 'DELETE',
        headers: { ...csrfHeaders() },
      });

      const data = await res.json();
      if (data.success) {
        toast.success('策略删除成功');
        setDeleteDialogOpen(false);
        setSelectedPolicy(null);
        loadPolicies();
      } else {
        toast.error('删除失败: ' + data.error);
      }
    } catch {
      toast.error('删除失败: 网络错误');
    }
  };

  // 切换启用状态
  const handleToggle = async (policy: Policy) => {
    try {
      const res = await fetch(`/api/policies/${policy.id}/toggle`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ isActive: !policy.isActive }),
      });

      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        loadPolicies();
      } else {
        toast.error('操作失败: ' + data.error);
      }
    } catch {
      toast.error('操作失败: 网络错误');
    }
  };

  // 设为默认
  const handleSetDefault = async (policy: Policy) => {
    try {
      const res = await fetch(`/api/policies/${policy.id}/set-default`, {
        method: 'PUT',
        headers: { ...csrfHeaders() },
      });

      const data = await res.json();
      if (data.success) {
        toast.success('已设为默认策略');
        loadPolicies();
      } else {
        toast.error('操作失败: ' + data.error);
      }
    } catch {
      toast.error('操作失败: 网络错误');
    }
  };

  // 获取维度显示名称
  const getDimensionLabel = (dimensionCode: string) => {
    // 优先从动态加载的维度数据中获取
    const dim = dimensions.find(d => d.code === dimensionCode);
    if (dim) {
      return dim.name;
    }
    // 兜底硬编码
    const labels: Record<string, string> = {
      prompt_injection: '提示词注入',
      pii_leak: 'PII泄露',
      malicious_code: '恶意代码',
      violence_hate: '暴力仇恨',
      illegal_content: '非法内容',
    };
    return labels[dimensionCode] || dimensionCode;
  };

  const filteredPolicies = policies.filter((policy) => {
    const matchesSearch = `${policy.name} ${policy.description ?? ''} ${(policy.tags ?? []).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase());
    const matchesDimension = dimensionFilter === 'all' || policy.rules.some((rule) => rule.enabled && rule.dimension === dimensionFilter);
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' ? policy.isActive : !policy.isActive);
    return matchesSearch && matchesDimension && matchesStatus;
  });
  const preview = filteredPolicies.find((policy) => policy.id === previewId) ?? filteredPolicies[0];
  const configuredDimensions = new Set(policies.flatMap((policy) => policy.rules.filter((rule) => rule.enabled).map((rule) => rule.dimension)));
  const categories = [{ code: 'all', name: '全部策略', count: policies.length }, ...Array.from(configuredDimensions).map((code) => ({
    code, name: getDimensionLabel(code), count: policies.filter((policy) => policy.rules.some((rule) => rule.enabled && rule.dimension === code)).length,
  }))];
  const policyActions = (policy: Policy) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`${policy.name}更多操作`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={`/policies/${policy.id}`}>
                        <Settings className="h-4 w-4 mr-2" />
                        详细配置
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setSelectedPolicy(policy);
                        setFormData({
                          name: policy.name,
                          description: policy.description || '',
                          tags: (policy.tags || []).join(', '),
                          cloneFrom: '',
                        });
                        setEditDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4 mr-2" />
                      编辑信息
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setSelectedPolicy(policy);
                        setFormData({ name: `${policy.name} (副本)`, description: '', tags: '', cloneFrom: '' });
                        setCloneDialogOpen(true);
                      }}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      克隆策略
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {!policy.isDefault && (
                      <DropdownMenuItem onClick={() => handleSetDefault(policy)}>
                        <StarOff className="h-4 w-4 mr-2" />
                        设为默认
                      </DropdownMenuItem>
                    )}
                    {!policy.isDefault && (
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => {
                          setSelectedPolicy(policy);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        删除策略
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="安全策略" description="统一配置检测规则、关键词库与风险处置策略" actions={
        <Button size="sm" onClick={() => setCreateDialogOpen(true)}><Plus className="size-4" />创建策略</Button>
      } />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="策略总数" value={policies.length} unit="个" hint="当前应用策略配置" icon={Shield} />
        <MetricCard label="已启用策略" value={policies.filter((policy) => policy.isActive).length} unit="个" hint="策略配置状态" icon={CheckCircle2} tone="green" />
        <MetricCard label="覆盖检测维度" value={configuredDimensions.size} unit="类" hint="已配置并启用的维度" icon={Layers} />
        <MetricCard label="关键词配置数" value={policies.reduce((sum, policy) => sum + policy.stats.totalKeywords, 0).toLocaleString('zh-CN')} unit="条" hint="按策略累计，可能重复" icon={BookOpenCheck} tone="amber" />
      </div>
      <div className="grid items-start gap-3 xl:grid-cols-[174px_minmax(0,1fr)_280px]">
        <Card className="min-w-0">
          <CardHeader><CardTitle>策略分类</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-1 px-2 xl:flex-col">
            {categories.map((category) => <button key={category.code} type="button" onClick={() => setDimensionFilter(category.code)} aria-pressed={dimensionFilter === category.code}
              className={cn('flex min-h-10 items-center gap-2 rounded border px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-primary', dimensionFilter === category.code ? 'border-blue-100 bg-blue-50 font-medium text-primary' : 'border-transparent text-muted-foreground hover:bg-muted')}>
              <Shield className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 break-words">{category.name}</span><span className="tabular-nums">{category.count}</span>
            </button>)}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle>策略列表</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="relative min-w-36 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input aria-label="搜索策略" placeholder="搜索策略名称或标签" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" /></div>
              <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger aria-label="策略状态" className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="active">已启用</SelectItem><SelectItem value="inactive">已禁用</SelectItem></SelectContent></Select>
            </div>
            {filteredPolicies.length ? <Table>
              <TableHeader><TableRow><TableHead>策略名称</TableHead><TableHead>检测维度</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
              <TableBody>{filteredPolicies.map((policy) => <TableRow key={policy.id} data-state={preview?.id === policy.id ? 'selected' : undefined}>
                <TableCell className="max-w-52"><button type="button" onClick={() => setPreviewId(policy.id)} className="block max-w-full truncate text-left font-medium text-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">{policy.name}</button><div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground"><span>v{policy.version}</span>{policy.isDefault && <Badge variant="secondary" className="px-1 py-0 text-[10px]">默认</Badge>}</div></TableCell>
                <TableCell className="text-muted-foreground">{policy.stats.configuredDimensions} / {policy.stats.totalDimensions}</TableCell>
                <TableCell><Switch aria-label={`${policy.name}启用状态`} checked={policy.isActive} onCheckedChange={() => void handleToggle(policy)} disabled={policy.isDefault} /></TableCell>
                <TableCell><div className="flex items-center"><Button size="sm" variant="link" asChild><Link href={`/policies/${policy.id}`}>配置</Link></Button>{policyActions(policy)}</div></TableCell>
              </TableRow>)}</TableBody>
            </Table> : <EmptyState title={policies.length ? '没有匹配的策略' : '暂无策略'} description={policies.length ? '调整分类、状态或搜索条件后重试' : '创建第一个检测策略开始配置'} />}
            <div className="mt-4 flex items-center justify-between border-t pt-3 text-[11px] text-muted-foreground"><span>共 {filteredPolicies.length} 个策略</span><span>选择策略查看详情</span></div>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader><CardTitle>策略配置详情</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            {preview ? <>
              <div><p className="text-xs text-muted-foreground">策略名称</p><h2 className="mt-2 break-words text-sm font-semibold">{preview.name}</h2><p className="mt-2 break-words text-xs leading-6 text-muted-foreground">{preview.description || '暂无策略描述'}</p></div>
              <div className="flex items-center justify-between border-y py-3 text-xs"><span className="text-muted-foreground">配置状态</span><Badge variant="outline" className={preview.isActive ? 'border-emerald-100 bg-emerald-50 text-emerald-600' : 'text-muted-foreground'}>{preview.isActive ? '已启用' : '已禁用'}</Badge></div>
              <div><h3 className="mb-3 text-xs font-semibold">已启用检测维度</h3><div className="space-y-3">{preview.rules.filter((rule) => rule.enabled).map((rule) => <div key={rule.id} className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 className="size-3.5 shrink-0 text-primary" />{getDimensionLabel(rule.dimension)}</div>)}{!preview.rules.some((rule) => rule.enabled) && <p className="text-xs text-muted-foreground">尚未启用检测维度</p>}</div></div>
              <dl className="space-y-3 border-t pt-4 text-xs"><div className="flex justify-between"><dt className="text-muted-foreground">关键词</dt><dd>{preview.stats.totalKeywords.toLocaleString('zh-CN')} 条</dd></div><div className="flex justify-between"><dt className="text-muted-foreground">关键词分类</dt><dd>{preview.stats.totalCategories} 类</dd></div><div className="flex justify-between"><dt className="text-muted-foreground">配置版本</dt><dd>v{preview.version}</dd></div></dl>
              {!!preview.tags?.length && <div className="flex flex-wrap gap-1">{preview.tags.map((tag) => <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>)}</div>}
              <p className="text-[11px] leading-5 text-muted-foreground">此处为策略配置，运行生效版本请在策略发布中查看。</p>
              <Button className="w-full" asChild><Link href={`/policies/${preview.id}`}><FileText className="size-4" />打开详细配置</Link></Button>
            </> : <EmptyState title="未选择策略" description="创建或选择策略后查看配置" />}
          </CardContent>
        </Card>
      </div>

      {/* 创建策略对话框 */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建策略</DialogTitle>
            <DialogDescription>创建新的检测策略，可选择从现有策略克隆</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">策略名称 *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="输入策略名称"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">描述</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="输入策略描述"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tags">标签</Label>
              <Input
                id="tags"
                value={formData.tags}
                onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                placeholder="多个标签用逗号分隔"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cloneFrom">从现有策略克隆</Label>
              <Select
                value={formData.cloneFrom}
                onValueChange={(value) => setFormData({ ...formData, cloneFrom: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择源策略（可选）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不克隆</SelectItem>
                  {policies.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

      {/* 克隆策略对话框 */}
      <Dialog open={cloneDialogOpen} onOpenChange={setCloneDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>克隆策略</DialogTitle>
            <DialogDescription>
              从 &quot;{selectedPolicy?.name}&quot; 创建副本
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="cloneName">新策略名称 *</Label>
              <Input
                id="cloneName"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="输入新策略名称"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloneDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleClone}>克隆</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑策略对话框 */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑策略</DialogTitle>
            <DialogDescription>修改策略基本信息</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="editName">策略名称 *</Label>
              <Input
                id="editName"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="输入策略名称"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editDescription">描述</Label>
              <Textarea
                id="editDescription"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="输入策略描述"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editTags">标签</Label>
              <Input
                id="editTags"
                value={formData.tags}
                onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                placeholder="多个标签用逗号分隔"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除策略 &quot;{selectedPolicy?.name}&quot; 吗？此操作不可恢复，相关的规则和关键词配置都将被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
