'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Plus,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
  Star,
  StarOff,
  Settings,
  FileText,
  Shield,
  AlertTriangle,
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
        headers: { 'Content-Type': 'application/json' },
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
    } catch (error) {
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
        headers: { 'Content-Type': 'application/json' },
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
    } catch (error) {
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
        headers: { 'Content-Type': 'application/json' },
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
    } catch (error) {
      toast.error('更新失败: 网络错误');
    }
  };

  // 删除策略
  const handleDelete = async () => {
    if (!selectedPolicy) return;

    try {
      const res = await fetch(`/api/policies?id=${selectedPolicy.id}`, {
        method: 'DELETE',
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
    } catch (error) {
      toast.error('删除失败: 网络错误');
    }
  };

  // 切换启用状态
  const handleToggle = async (policy: Policy) => {
    try {
      const res = await fetch(`/api/policies/${policy.id}/toggle`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !policy.isActive }),
      });

      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        loadPolicies();
      } else {
        toast.error('操作失败: ' + data.error);
      }
    } catch (error) {
      toast.error('操作失败: 网络错误');
    }
  };

  // 设为默认
  const handleSetDefault = async (policy: Policy) => {
    try {
      const res = await fetch(`/api/policies/${policy.id}/set-default`, {
        method: 'PUT',
      });

      const data = await res.json();
      if (data.success) {
        toast.success('已设为默认策略');
        loadPolicies();
      } else {
        toast.error('操作失败: ' + data.error);
      }
    } catch (error) {
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">策略配置</h1>
          <p className="text-muted-foreground mt-1">
            管理检测策略、配置规则和关键词库
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          创建策略
        </Button>
      </div>

      {/* 策略卡片列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {policies.map((policy) => (
          <Card key={policy.id} className={`relative ${!policy.isActive ? 'opacity-60' : ''}`}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2">
                    {policy.name}
                    {policy.isDefault && (
                      <Badge variant="default" className="text-xs">
                        <Star className="h-3 w-3 mr-1" />
                        默认
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="line-clamp-2">
                    {policy.description || '暂无描述'}
                  </CardDescription>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon">
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
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 标签 */}
              {policy.tags && policy.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {policy.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              {/* 规则概览 */}
              <div className="space-y-2">
                <div className="text-sm font-medium">检测维度</div>
                <div className="flex flex-wrap gap-1">
                  {policy.rules.filter((r) => r.enabled).slice(0, 5).map((rule) => (
                    <Badge key={rule.id} variant="outline" className="text-xs">
                      {getDimensionLabel(rule.dimension)}
                    </Badge>
                  ))}
                  {policy.rules.filter((r) => r.enabled).length > 5 && (
                    <Badge variant="outline" className="text-xs">
                      +{policy.rules.filter((r) => r.enabled).length - 5}
                    </Badge>
                  )}
                </div>
              </div>

              {/* 统计信息 */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-muted/50 rounded-lg p-2">
                  <div className="text-lg font-semibold">{policy.stats.configuredDimensions}/{policy.stats.totalDimensions}</div>
                  <div className="text-xs text-muted-foreground">规则</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-2">
                  <div className="text-lg font-semibold">{policy.stats.totalKeywords}</div>
                  <div className="text-xs text-muted-foreground">关键词</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-2">
                  <div className="text-lg font-semibold">{policy.stats.totalCategories}</div>
                  <div className="text-xs text-muted-foreground">分类</div>
                </div>
              </div>
            </CardContent>
            <CardFooter className="pt-3 border-t">
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={policy.isActive}
                    onCheckedChange={() => handleToggle(policy)}
                    disabled={policy.isDefault}
                  />
                  <span className="text-sm text-muted-foreground">
                    {policy.isActive ? '已启用' : '已禁用'}
                  </span>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/policies/${policy.id}`}>
                    <FileText className="h-4 w-4 mr-1" />
                    配置
                  </Link>
                </Button>
              </div>
            </CardFooter>
          </Card>
        ))}
      </div>

      {/* 空状态 */}
      {policies.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Shield className="h-12 w-12 text-muted-foreground mb-4" />
            <div className="text-lg font-medium">暂无策略</div>
            <div className="text-sm text-muted-foreground mb-4">
              创建第一个检测策略开始使用
            </div>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              创建策略
            </Button>
          </CardContent>
        </Card>
      )}

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
