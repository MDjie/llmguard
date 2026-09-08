'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
  Settings,
  Trash2,
  Shield,
  Code,
  AlertTriangle,
  Ban,
  UserX,
  Eye,
  Pencil,
} from 'lucide-react';
import { apiErrorMessage } from '@/lib/api-client-error';
import { usePermissions } from '@/hooks/use-permissions';
import { csrfHeaders } from '@/lib/auth/csrf-client';

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
  ruleCount: number;
  groupCount: number;
}

const categoryColors: Record<string, string> = {
  security: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  privacy: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  compliance: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  content: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  spam: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  safety: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  quality: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
};

const categoryLabels: Record<string, string> = {
  security: '安全',
  privacy: '隐私',
  compliance: '合规',
  content: '内容',
  spam: '垃圾信息',
  safety: '人身安全',
  quality: '质量',
  custom: '自定义',
};

const dimensionIcons: Record<string, React.ReactNode> = {
  prompt_injection: <Shield className="h-5 w-5" />,
  pii_leak: <UserX className="h-5 w-5" />,
  malicious_code: <Code className="h-5 w-5" />,
  violence_hate: <AlertTriangle className="h-5 w-5" />,
  illegal_content: <Ban className="h-5 w-5" />,
  ad_detection: <Eye className="h-5 w-5" />,
  spam_detection: <Eye className="h-5 w-5" />,
  sensitive_compliance: <Eye className="h-5 w-5" />,
  adult_content: <Eye className="h-5 w-5" />,
  self_harm: <Eye className="h-5 w-5" />,
  credential_secret_leak: <Eye className="h-5 w-5" />,
  fraud_scam: <Eye className="h-5 w-5" />,
  misinformation: <Eye className="h-5 w-5" />,
  copyright_risk: <Eye className="h-5 w-5" />,
  business_sensitive: <Eye className="h-5 w-5" />,
  output_leak: <Eye className="h-5 w-5" />,
  politically_sensitive: <AlertTriangle className="h-5 w-5" />,
  hallucination: <Eye className="h-5 w-5" />,
  topic_safety: <Shield className="h-5 w-5" />,
  dialog_manipulation: <Ban className="h-5 w-5" />,
  data_exfiltration: <UserX className="h-5 w-5" />,
  model_extraction: <Code className="h-5 w-5" />,
  livelihood_sensitive: <Eye className="h-5 w-5" />,
  public_health_sensitive: <AlertTriangle className="h-5 w-5" />,
  malicious_url: <Ban className="h-5 w-5" />,
};

export default function DimensionsPage() {
  const router = useRouter();
  const canManage = usePermissions()('policy:manage');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingDimension, setEditingDimension] = useState<Dimension | null>(null);
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    description: '',
    category: 'custom',
    weight: '1.0',
    priority: '100',
  });

  const fetchDimensions = async () => {
    try {
      const response = await fetch('/api/dimensions');
      const result = await response.json();
      if (result.success) {
        setDimensions(result.data);
      } else { toast.error(apiErrorMessage(result, '获取维度列表失败')); }
    } catch (error) {
      console.error('获取维度列表失败:', error);
      toast.error('获取维度列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDimensions();
  }, []);

  const handleCreate = async () => {
    if (!formData.code || !formData.name) {
      toast.error('请填写维度编码和名称');
      return;
    }

    try {
      const response = await fetch('/api/dimensions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          ...formData,
          weight: parseFloat(formData.weight),
          priority: parseInt(formData.priority),
        }),
      });

      const result = await response.json();
      if (result.success) {
        toast.success('创建维度成功');
        setCreateDialogOpen(false);
        setFormData({
          code: '',
          name: '',
          description: '',
          category: 'custom',
          weight: '1.0',
          priority: '100',
        });
        fetchDimensions();
      } else {
        toast.error(apiErrorMessage(result, '创建失败'));
      }
    } catch (error) {
      console.error('创建维度失败:', error);
      toast.error('创建维度失败');
    }
  };

  const handleEdit = (dimension: Dimension) => {
    setEditingDimension(dimension);
    setFormData({
      code: dimension.code,
      name: dimension.name,
      description: dimension.description || '',
      category: dimension.category || 'custom',
      weight: dimension.weight,
      priority: dimension.priority.toString(),
    });
    setEditDialogOpen(true);
  };

  const handleUpdate = async () => {
    if (!editingDimension || !formData.name) {
      toast.error('请填写维度名称');
      return;
    }

    try {
      const response = await fetch(`/api/dimensions/${editingDimension.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description,
          category: formData.category,
          weight: parseFloat(formData.weight),
          priority: parseInt(formData.priority),
        }),
      });

      const result = await response.json();
      if (result.success) {
        toast.success('更新维度成功');
        setEditDialogOpen(false);
        setEditingDimension(null);
        fetchDimensions();
      } else {
        toast.error(apiErrorMessage(result, '更新失败'));
      }
    } catch (error) {
      console.error('更新维度失败:', error);
      toast.error('更新维度失败');
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      const response = await fetch(`/api/dimensions/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ enabled }),
      });

      const result = await response.json();
      if (result.success) {
        toast.success(enabled ? '已启用' : '已禁用');
        fetchDimensions();
      } else {
        toast.error(apiErrorMessage(result, '操作失败'));
      }
    } catch (error) {
      console.error('切换状态失败:', error);
      toast.error('操作失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除该维度吗？此操作不可恢复。')) return;

    try {
      const response = await fetch(`/api/dimensions/${id}`, {
        method: 'DELETE',
        headers: { ...csrfHeaders() },
      });

      const result = await response.json();
      if (result.success) {
        toast.success('删除成功');
        fetchDimensions();
      } else {
        toast.error(apiErrorMessage(result, '删除失败'));
      }
    } catch (error) {
      console.error('删除维度失败:', error);
      toast.error('删除维度失败');
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
          <h1 className="text-3xl font-bold">检测维度管理</h1>
          <p className="text-muted-foreground mt-2">
            管理检测维度和规则，支持自定义检测能力
          </p>
        </div>
        <Button disabled={!canManage} onClick={() => { setFormData({ code: "", name: "", description: "", category: "custom", weight: "1.0", priority: "100" }); setCreateDialogOpen(true); }}>
          <Plus className="h-4 w-4 mr-2" />
          新建维度
        </Button>
      </div>

      <div className="mb-6 flex flex-wrap gap-3">
        <Input className="max-w-sm" aria-label="搜索维度" placeholder="按名称或编码搜索" value={search} onChange={event=>setSearch(event.target.value)}/>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}><SelectTrigger className="w-40" aria-label="筛选分类"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部分类</SelectItem>{[...new Set([...Object.keys(categoryLabels),...dimensions.flatMap(item=>item.category?[item.category]:[])])].map(key=><SelectItem key={key} value={key}>{categoryLabels[key]??key}</SelectItem>)}</SelectContent></Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="w-40" aria-label="筛选状态"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="true">已启用</SelectItem><SelectItem value="false">已停用</SelectItem></SelectContent></Select>
        <Button variant="outline" onClick={()=>{setSearch('');setCategoryFilter('all');setStatusFilter('all');}}>重置筛选</Button>
      </div>
      {!canManage && <p className="mb-4 text-sm text-muted-foreground">当前角色仅可查看检测配置。</p>}
      {/* 维度卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {dimensions.filter(dimension => (!search.trim() || `${dimension.name} ${dimension.code}`.toLowerCase().includes(search.trim().toLowerCase())) && (categoryFilter === 'all' || dimension.category === categoryFilter) && (statusFilter === 'all' || String(dimension.enabled) === statusFilter)).map((dimension) => (
          <Card key={dimension.id} className="relative">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800">
                    {dimensionIcons[dimension.code] || <Eye className="h-5 w-5" />}
                  </div>
                  <div>
                    <CardTitle className="text-lg">{dimension.name}</CardTitle>
                    <CardDescription className="text-sm font-mono">
                      {dimension.code}
                    </CardDescription>
                  </div>
                </div>
                {dimension.isSystem && (
                  <Badge variant="secondary" className="text-xs">
                    系统
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                {dimension.description || '暂无描述'}
              </p>

              <div className="flex items-center gap-4 mb-4">
                {dimension.category && (
                  <Badge className={categoryColors[dimension.category] || ''}>
                    {categoryLabels[dimension.category] || dimension.category}
                  </Badge>
                )}
                <Badge variant="outline">
                  {dimension.ruleCount} 条规则
                </Badge>
              </div>

              <div className="flex items-center justify-between pt-4 border-t">
                <div className="flex items-center gap-2">
                  <Switch
                    disabled={!canManage}
                    aria-label={`${dimension.name}启用状态`}
                    checked={dimension.enabled}
                    onCheckedChange={(checked) => handleToggle(dimension.id, checked)}
                  />
                  <span className="text-sm text-muted-foreground">
                    {dimension.enabled ? '已启用' : '已禁用'}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    title="编辑"
                    disabled={!canManage}
                    onClick={() => handleEdit(dimension)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="规则配置"
                    onClick={() => router.push(`/dimensions/${dimension.id}`)}
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                  {!dimension.isSystem && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title="删除"
                      disabled={!canManage}
                      onClick={() => handleDelete(dimension.id)}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {dimensions.filter(item => (!search.trim() || `${item.name} ${item.code}`.toLowerCase().includes(search.trim().toLowerCase())) && (categoryFilter === "all" || item.category === categoryFilter) && (statusFilter === "all" || String(item.enabled) === statusFilter)).length === 0 && <p className="py-12 text-center text-muted-foreground">没有符合筛选条件的维度</p>}

      {/* 创建对话框 */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建检测维度</DialogTitle>
            <DialogDescription>
              创建新的检测维度，支持自定义检测规则
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="code">维度编码</Label>
              <Input
                id="code"
                placeholder="例如：ad_detection"
                value={formData.code}
                onChange={(e) => setFormData({ ...formData, code: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                英文编码，用于API调用
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">维度名称</Label>
              <Input
                id="name"
                placeholder="例如：广告检测"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">描述</Label>
              <Textarea
                id="description"
                placeholder="维度描述..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">分类</Label>
              <Select
                value={formData.category}
                onValueChange={(value) => setFormData({ ...formData, category: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择分类" />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set([...Object.keys(categoryLabels), ...(formData.category ? [formData.category] : [])])].map(key=><SelectItem key={key} value={key}>{categoryLabels[key]??key}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="weight">权重</Label>
                <Input
                  id="weight"
                  type="number"
                  step="0.1"
                  value={formData.weight}
                  onChange={(e) => setFormData({ ...formData, weight: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="priority">优先级</Label>
                <Input
                  id="priority"
                  type="number"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={!canManage} onClick={handleCreate}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑对话框 */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑检测维度</DialogTitle>
            <DialogDescription>
              修改维度的基本信息
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-code">维度编码</Label>
              <Input
                id="edit-code"
                value={formData.code}
                disabled
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                维度编码创建后不可修改
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-name">维度名称</Label>
              <Input
                id="edit-name"
                placeholder="例如：广告检测"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-description">描述</Label>
              <Textarea
                id="edit-description"
                placeholder="维度描述..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-category">分类</Label>
              <Select
                value={formData.category}
                onValueChange={(value) => setFormData({ ...formData, category: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择分类" />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set([...Object.keys(categoryLabels), ...(formData.category ? [formData.category] : [])])].map(key=><SelectItem key={key} value={key}>{categoryLabels[key]??key}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-weight">权重</Label>
                <Input
                  id="edit-weight"
                  type="number"
                  step="0.1"
                  value={formData.weight}
                  onChange={(e) => setFormData({ ...formData, weight: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-priority">优先级</Label>
                <Input
                  id="edit-priority"
                  type="number"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={!canManage} onClick={handleUpdate}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
