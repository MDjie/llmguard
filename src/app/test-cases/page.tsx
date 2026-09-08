'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { ShieldCheck, RefreshCw, Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { SampleImportDialog } from '@/components/evaluation/sample-import-dialog';
import { usePermissions } from '@/hooks/use-permissions';
import { apiErrorMessage } from '@/lib/api-client-error';
import { csrfHeaders } from '@/lib/auth/csrf-client';

interface TestCase {
  id: string;
  title: string;
  description: string | null;
  category: string;
  inputText: string;
  outputText: string | null;
  expectedAction: string;
  expectedDimensions: string[];
  expectedScoreMin: number;
  expectedScoreMax: number;
  severity: string;
  enabled: boolean;
  createdAt: string;
}

const CATEGORY_OPTIONS = [
  { value: 'normal_qa', label: '正常问答' },
  { value: 'prompt_injection', label: '提示词注入' },
  { value: 'pii_leak', label: 'PII泄露' },
  { value: 'malicious_code', label: '恶意代码' },
  { value: 'illegal_content', label: '非法内容' },
  { value: 'credential_secret_leak', label: '密钥泄露' },
  { value: 'ad_detection', label: '广告检测' },
  { value: 'spam_detection', label: '垃圾信息' },
];

const SEVERITY_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'critical', label: '严重' },
];

const ACTION_OPTIONS = [
  { value: 'allow', label: '放行' },
  { value: 'warn', label: '警告' },
  { value: 'block', label: '拦截' },
  { value: 'mask', label: '脱敏' },
];

const DEFAULT_FORM = {
  title: '',
  description: '',
  category: 'normal_qa',
  inputText: '',
  outputText: '',
  expectedAction: 'allow',
  expectedDimensions: '',
  expectedScoreMin: 0,
  expectedScoreMax: 100,
  severity: 'medium',
  enabled: true,
};

export default function TestCasesPage() {
  const canManage = usePermissions()('policy:manage');
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // 弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  
  // 表单数据
  const [form, setForm] = useState(DEFAULT_FORM);

  const fetchTestCases = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/test-cases');
      const result = await response.json();
      if (result.success) {
        setTestCases(result.data || []);
        setError(null);
      } else {
        setError('加载策略验证集失败');
      }
    } catch (err) {
      console.error('加载策略验证集失败:', err);
      setError('加载策略验证集失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTestCases();
  }, []);

  // 打开新增弹窗
  const handleAdd = () => {
    setForm(DEFAULT_FORM);
    setEditingId(null);
    setDialogOpen(true);
  };

  // 打开编辑弹窗
  const handleEdit = (testCase: TestCase) => {
    setForm({
      title: testCase.title,
      description: testCase.description || '',
      category: testCase.category,
      inputText: testCase.inputText,
      outputText: testCase.outputText || '',
      expectedAction: testCase.expectedAction,
      expectedDimensions: Array.isArray(testCase.expectedDimensions) 
        ? testCase.expectedDimensions.join(', ') 
        : '',
      expectedScoreMin: Number(testCase.expectedScoreMin),
      expectedScoreMax: Number(testCase.expectedScoreMax),
      severity: testCase.severity,
      enabled: testCase.enabled,
    });
    setEditingId(testCase.id);
    setDialogOpen(true);
  };

  // 打开删除确认弹窗
  const handleDeleteConfirm = (id: string) => {
    setDeletingId(id);
    setDeleteDialogOpen(true);
  };

  // 保存验证样本
  const handleSave = async () => {
    if (!form.title.trim()) {
      toast.error('请输入标题');
      return;
    }
    if (!form.inputText.trim()) {
      toast.error('请输入验证内容');
      return;
    }

    try {
      setSaving(true);
      
      const payload = {
        title: form.title,
        description: form.description || '',
        category: form.category,
        inputText: form.inputText,
        outputText: form.outputText || null,
        expectedAction: form.expectedAction,
        expectedDimensions: form.expectedDimensions 
          ? form.expectedDimensions.split(',').map(s => s.trim()).filter(Boolean)
          : [],
        expectedScoreMin: form.expectedScoreMin,
        expectedScoreMax: form.expectedScoreMax,
        severity: form.severity,
        enabled: form.enabled,
      };

      let response;
      if (editingId) {
        // 更新
        response = await fetch(`/api/test-cases/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
          body: JSON.stringify(payload),
        });
      } else {
        // 新增
        response = await fetch('/api/test-cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
          body: JSON.stringify(payload),
        });
      }

      const result = await response.json();
      if (result.success) {
        toast.success(editingId ? '更新成功' : '创建成功');
        setDialogOpen(false);
        fetchTestCases();
      } else {
        toast.error(apiErrorMessage(result, '保存失败'));
      }
    } catch (err) {
      console.error('保存失败:', err);
      toast.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  // 删除验证样本
  const handleDelete = async () => {
    if (!deletingId) return;

    try {
      setSaving(true);
      const response = await fetch(`/api/test-cases/${deletingId}`, {
        method: 'DELETE',
        headers: csrfHeaders(),
      });
      const result = await response.json();
      if (result.success) {
        toast.success('删除成功');
        setDeleteDialogOpen(false);
        setDeletingId(null);
        fetchTestCases();
      } else {
        toast.error(apiErrorMessage(result, '删除失败'));
      }
    } catch (err) {
      console.error('删除失败:', err);
      toast.error('删除失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const getCategoryColor = (category: string) => {
    const colors: Record<string, string> = {
      normal_qa: 'bg-green-100 text-green-700',
      prompt_injection: 'bg-red-100 text-red-700',
      pii_leak: 'bg-yellow-100 text-yellow-700',
      malicious_code: 'bg-purple-100 text-purple-700',
      violence_hate: 'bg-orange-100 text-orange-700',
      illegal_content: 'bg-pink-100 text-pink-700',
      credential_secret_leak: 'bg-blue-100 text-blue-700',
      ad_detection: 'bg-cyan-100 text-cyan-700',
      spam_detection: 'bg-gray-100 text-gray-700',
    };
    return colors[category] || 'bg-gray-100 text-gray-700';
  };

  const getCategoryLabel = (category: string) => {
    const option = CATEGORY_OPTIONS.find(o => o.value === category);
    return option?.label || category;
  };

  const getSeverityColor = (severity: string) => {
    const colors: Record<string, string> = {
      low: 'bg-green-50 text-green-600',
      medium: 'bg-yellow-50 text-yellow-600',
      high: 'bg-orange-50 text-orange-600',
      critical: 'bg-red-50 text-red-600',
    };
    return colors[severity] || 'bg-gray-50 text-gray-600';
  };

  const getSeverityLabel = (severity: string) => {
    const option = SEVERITY_OPTIONS.find(o => o.value === severity);
    return option?.label || severity;
  };

  const getActionLabel = (action: string) => {
    const option = ACTION_OPTIONS.find(o => o.value === action);
    return option?.label || action;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">策略验证集</h1>
          <p className="text-gray-600 mt-1">管理策略验证样本，用于回归评测与发布门禁</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchTestCases}>
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新
          </Button>
          <SampleImportDialog disabled={!canManage} onImported={()=>void fetchTestCases()}/>
          <Button disabled={!canManage} className="bg-blue-600 hover:bg-blue-700" onClick={handleAdd}>
            <Plus className="h-4 w-4 mr-2" />
            新增用例
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <span className="ml-3 text-gray-600">加载中...</span>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-700">{error}</p>
          <Button variant="outline" className="mt-4" onClick={fetchTestCases}>
            重试
          </Button>
        </div>
      ) : testCases.length === 0 ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center">
          <ShieldCheck className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600">暂无策略验证样本</p>
          <Button disabled={!canManage} className="mt-4" onClick={handleAdd}>
            <Plus className="h-4 w-4 mr-2" />
            添加验证样本
          </Button>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-lg border">
            <div className="p-4 border-b">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">共 {testCases.length} 条验证样本</span>
              </div>
            </div>

            <div className="divide-y">
              {testCases.map((testCase) => (
                <div key={testCase.id} className="p-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="font-medium text-gray-900">{testCase.title}</h3>
                        <Badge className={getCategoryColor(testCase.category)}>
                          {getCategoryLabel(testCase.category)}
                        </Badge>
                        <Badge className={getSeverityColor(testCase.severity)}>
                          {getSeverityLabel(testCase.severity)}
                        </Badge>
                        {!testCase.enabled && (
                          <Badge className="bg-gray-100 text-gray-500">已禁用</Badge>
                        )}
                      </div>
                      {testCase.description && (
                        <p className="text-sm text-gray-600 mb-2">{testCase.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-sm text-gray-500">
                        <span>期望动作: <strong>{getActionLabel(testCase.expectedAction)}</strong></span>
                        <span>分数范围: {testCase.expectedScoreMin}-{testCase.expectedScoreMax}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={!canManage} onClick={() => handleEdit(testCase)}>
                        <Pencil className="h-4 w-4 mr-1" />
                        编辑
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        disabled={!canManage} onClick={() => handleDeleteConfirm(testCase.id)}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>正常问答</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">
                  {testCases.filter(t => t.category === 'normal_qa').length}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>提示词注入</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600">
                  {testCases.filter(t => t.category === 'prompt_injection').length}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>PII泄露</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-yellow-600">
                  {testCases.filter(t => t.category === 'pii_leak').length}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>其他风险</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-purple-600">
                  {testCases.filter(t => !['normal_qa', 'prompt_injection', 'pii_leak'].includes(t.category)).length}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑验证样本' : '新增验证样本'}</DialogTitle>
            <DialogDescription>
              {editingId ? '修改验证样本信息' : '创建新的验证样本'}
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="title">标题 *</Label>
                <Input
                  id="title"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="验证样本标题"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="category">类别</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择类别" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">描述</Label>
              <Input
                id="description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="验证样本描述"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="inputText">输入内容 *</Label>
              <Textarea
                id="inputText"
                value={form.inputText}
                onChange={(e) => setForm({ ...form, inputText: e.target.value })}
                placeholder="输入待验证内容"
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="outputText">预期输出（可选）</Label>
              <Textarea
                id="outputText"
                value={form.outputText}
                onChange={(e) => setForm({ ...form, outputText: e.target.value })}
                placeholder="预期的模型输出"
                rows={2}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="expectedAction">期望动作</Label>
                <Select value={form.expectedAction} onValueChange={(v) => setForm({ ...form, expectedAction: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择动作" />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="severity">严重级别</Label>
                <Select value={form.severity} onValueChange={(v) => setForm({ ...form, severity: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择严重级别" />
                  </SelectTrigger>
                  <SelectContent>
                    {SEVERITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="expectedDimensions">期望命中维度（逗号分隔）</Label>
              <Input
                id="expectedDimensions"
                value={form.expectedDimensions}
                onChange={(e) => setForm({ ...form, expectedDimensions: e.target.value })}
                placeholder="prompt_injection, pii_leak"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="expectedScoreMin">最低分数</Label>
                <Input
                  id="expectedScoreMin"
                  type="number"
                  min={0}
                  max={100}
                  value={form.expectedScoreMin}
                  onChange={(e) => setForm({ ...form, expectedScoreMin: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expectedScoreMax">最高分数</Label>
                <Input
                  id="expectedScoreMax"
                  type="number"
                  min={0}
                  max={100}
                  value={form.expectedScoreMax}
                  onChange={(e) => setForm({ ...form, expectedScoreMax: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={handleSave} disabled={saving || !canManage}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              此操作将永久删除该验证样本，无法恢复。确定要继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={saving || !canManage}
            >
              {saving ? '删除中...' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
