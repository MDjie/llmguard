'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { 
  Plus, 
  Edit2, 
  Trash2, 
  Power, 
  CheckCircle2, 
  XCircle, 
  Loader2,
  Cloud,
  Wifi
} from 'lucide-react';

interface LLMProvider {
  id: string;
  name: string;
  displayName: string;
  providerType: string;
  baseUrl: string | null;
  hasSecret: boolean;
  requiresSecretMigration: boolean;
  defaultModel: string | null;
  useCase: string;
  isEnabled: boolean;
  isDefaultTarget: boolean;
  isDefaultJudge: boolean;
  avgLatencyMs: number | null;
  lastTestAt: string | null;
  lastTestSuccess: boolean | null;
  createdAt: string;
}

interface TestResult {
  success: boolean;
  latencyMs?: number;
  message?: string;
  testedAt: string;
}

const providerTypes = [
  { value: 'openai_compatible', label: 'OpenAI Compatible' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'kimi', label: 'Kimi (月之暗面)' },
  { value: 'doubao', label: '豆包 (字节跳动)' },
  { value: 'qwen', label: '通义千问 (阿里)' },
  { value: 'ollama', label: 'Ollama (本地)' },
  { value: 'custom', label: '自定义 OpenAI 兼容端点' },
];

const useCases = [
  { value: 'target', label: '被测模型', description: '在检测工作台作为被测模型使用' },
  { value: 'judge', label: '裁判模型', description: '在多模型评测中作为裁判模型使用' },
  { value: 'both', label: '两者均可', description: '可在检测工作台和多模型评测中使用' },
  { value: 'ocr', label: 'OCR 模型', description: '仅在文档检测中用于图片文字识别，不可用于其他场景' },
];

export default function ProvidersPage() {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<LLMProvider | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  
  // 表单状态
  const [formData, setFormData] = useState({
    name: '',
    displayName: '',
    providerType: 'openai_compatible',
    baseUrl: '',
    apiKey: '',
    defaultModel: '',
    useCase: 'both',
  });

  useEffect(() => {
    loadProviders();
  }, []);

  async function loadProviders() {
    setLoading(true);
    try {
      const response = await fetch('/api/providers');
      const data = await response.json();
      if (data.success) {
        setProviders(data.data);
      }
    } catch (error) {
      console.error('加载 Provider 列表失败:', error);
      toast.error('加载供应商列表失败');
    } finally {
      setLoading(false);
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const url = editingProvider 
        ? `/api/providers?id=${editingProvider.id}`
        : '/api/providers';
      
      const method = editingProvider ? 'PUT' : 'POST';
      
      const body: Record<string, unknown> = {
        name: formData.name,
        displayName: formData.displayName,
        providerType: formData.providerType,
        baseUrl: formData.baseUrl || null,
        defaultModel: formData.defaultModel || null,
        useCase: formData.useCase,
      };

      // 只在创建时或提供了新密钥时才发送 apiKey
      if (!editingProvider || formData.apiKey) {
        body.apiKey = formData.apiKey || null;
      }

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (data.success) {
        toast.success(editingProvider ? '供应商更新成功' : '供应商创建成功');
        setShowForm(false);
        setEditingProvider(null);
        loadProviders();
      } else {
        toast.error(data.detail || data.error || '操作失败');
      }
    } catch (error) {
      console.error('保存失败:', error);
      toast.error('保存失败，请重试');
    }
  };

  const handleEdit = (provider: LLMProvider) => {
    setEditingProvider(provider);
    setFormData({
      name: provider.name,
      displayName: provider.displayName,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl || '',
      apiKey: '', // 不显示已有密钥
      defaultModel: provider.defaultModel || '',
      useCase: provider.useCase,
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个供应商吗？')) return;

    try {
      const response = await fetch(`/api/providers?id=${id}`, {
        method: 'DELETE',
        headers: csrfHeaders(),
      });

      const data = await response.json();

      if (data.success) {
        toast.success('供应商已删除');
        loadProviders();
      } else {
        toast.error(data.detail || data.error || '删除失败');
      }
    } catch (error) {
      console.error('删除失败:', error);
      toast.error('删除失败，请重试');
    }
  };

  const handleToggle = async (provider: LLMProvider) => {
    try {
      const response = await fetch(`/api/providers?id=${provider.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ isEnabled: !provider.isEnabled }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success(provider.isEnabled ? '供应商已停用' : '供应商已启用');
        loadProviders();
      } else {
        toast.error(data.detail || data.error || '操作失败');
      }
    } catch (error) {
      console.error('切换状态失败:', error);
      toast.error('操作失败，请重试');
    }
  };

  const handleTestProvider = async (providerId: string) => {
    if (testingProviderId) return;

    setTestingProviderId(providerId);

    try {
      const res = await fetch('/api/providers/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...csrfHeaders(),
        },
        body: JSON.stringify({ providerId }),
      });

      let data: { success: boolean; data?: { testSuccess?: boolean; latencyMs?: number; error?: string; errorCode?: string }; error?: string; detail?: string } | null = null;

      try {
        data = await res.json();
      } catch {
        throw new Error(`接口响应异常：${res.status}`);
      }

      if (!res.ok || !data?.success) {
        throw new Error(data?.detail || data?.error || '测试连接失败');
      }

      const latencyMs = data.data?.latencyMs ?? 0;
      const testSuccess = data.data?.testSuccess ?? true;

      setTestResults(prev => ({
        ...prev,
        [providerId]: {
          success: testSuccess,
          latencyMs,
          message: testSuccess ? '连接正常' : (data?.data?.errorCode || data?.data?.error || '测试失败'),
          testedAt: new Date().toLocaleTimeString(),
        },
      }));

      if (testSuccess) {
        toast.success(`测试成功，延迟 ${latencyMs}ms`);
      } else {
        toast.error(data?.data?.error || '测试失败');
      }

      // 刷新列表以显示最新测试结果
      loadProviders();
    } catch (error) {
      const message = error instanceof Error ? error.message : '测试连接失败';

      setTestResults(prev => ({
        ...prev,
        [providerId]: {
          success: false,
          message,
          testedAt: new Date().toLocaleTimeString(),
        },
      }));

      toast.error(message);
    } finally {
      setTestingProviderId(null);
    }
  };

  const getProviderTypeLabel = (type: string) => {
    return providerTypes.find(p => p.value === type)?.label || type;
  };

  const getUseCaseLabel = (useCase: string) => {
    return useCases.find(u => u.value === useCase)?.label || useCase;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">模型供应商管理</h1>
          <p className="text-gray-600 mt-1">配置和管理 LLM API 供应商，支持多种大模型接入</p>
        </div>
        <Button onClick={() => {
          setEditingProvider(null);
          setFormData({
            name: '',
            displayName: '',
            providerType: 'openai_compatible',
            baseUrl: '',
            apiKey: '',
            defaultModel: '',
            useCase: 'both',
          });
          setShowForm(true);
        }}>
          <Plus className="h-4 w-4 mr-2" />
          新增供应商
        </Button>
      </div>

      {/* 新增/编辑表单 */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{editingProvider ? '编辑供应商' : '新增供应商'}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">供应商名称 *</label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="例如: deepseek-chat"
                    required
                    disabled={!!editingProvider}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">显示名称 *</label>
                  <Input
                    value={formData.displayName}
                    onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                    placeholder="例如: DeepSeek Chat"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">供应商类型 *</label>
                  <Select 
                    value={formData.providerType} 
                    onValueChange={(v) => setFormData({ ...formData, providerType: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {providerTypes.map(type => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">用途 *</label>
                  <Select 
                    value={formData.useCase} 
                    onValueChange={(v) => setFormData({ ...formData, useCase: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {useCases.map(uc => (
                        <SelectItem key={uc.value} value={uc.value}>
                          {uc.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">API Base URL</label>
                <Input
                  value={formData.baseUrl}
                  onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                  placeholder="例如: https://api.deepseek.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  API Key {editingProvider && '（留空保持不变）'}
                </label>
                <Input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder="输入 API Key"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">默认模型</label>
                <Input
                  value={formData.defaultModel}
                  onChange={(e) => setFormData({ ...formData, defaultModel: e.target.value })}
                  placeholder="例如: deepseek-chat"
                />
              </div>

              <div className="flex gap-2">
                <Button type="submit">
                  {editingProvider ? '保存' : '创建'}
                </Button>
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => {
                    setShowForm(false);
                    setEditingProvider(null);
                  }}
                >
                  取消
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Provider 列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-full flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : providers.length === 0 ? (
          <div className="col-span-full text-center py-12 text-gray-500">
            <Cloud className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>暂无供应商，点击 &quot;新增供应商&quot; 添加</p>
          </div>
        ) : (
          providers.map((provider) => {
            const testResult = testResults[provider.id];
            
            return (
              <Card key={provider.id} className={!provider.isEnabled ? 'opacity-60' : ''}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{provider.displayName}</CardTitle>
                      <CardDescription className="text-xs mt-1">{provider.name}</CardDescription>
                    </div>
                    <div className="flex gap-1">
                      <Badge variant={provider.isEnabled ? 'default' : 'secondary'}>
                        {provider.isEnabled ? '已启用' : '已停用'}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500">类型：</span>
                    <Badge variant="outline">{getProviderTypeLabel(provider.providerType)}</Badge>
                  </div>
                  
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500">用途：</span>
                    <Badge variant="outline">{getUseCaseLabel(provider.useCase)}</Badge>
                  </div>

                  {provider.defaultModel && (
                    <div className="text-sm">
                      <span className="text-gray-500">默认模型：</span>
                      <span className="font-mono text-xs">{provider.defaultModel}</span>
                    </div>
                  )}

                  {/* 测试结果展示 */}
                  {testResult && (
                    <div
                      className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
                        testResult.success
                          ? 'border-green-200 bg-green-50 text-green-700'
                          : 'border-red-200 bg-red-50 text-red-700'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          {testResult.success ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : (
                            <XCircle className="h-4 w-4" />
                          )}
                          {testResult.success ? '最近测试成功' : '最近测试失败'}
                        </span>

                        <span className="text-xs opacity-70">
                          {testResult.testedAt}
                        </span>
                      </div>

                      <div className="mt-1 text-xs">
                        {testResult.success
                          ? `延迟：${testResult.latencyMs ?? '--'}ms`
                          : testResult.message}
                      </div>
                    </div>
                  )}

                  {/* 如果数据库有测试结果但本地没有，显示数据库的结果 */}
                  {!testResult && provider.lastTestSuccess !== null && (
                    <div className="flex items-center gap-1 text-sm">
                      {provider.lastTestSuccess ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-600" />
                      )}
                      <span className={provider.lastTestSuccess ? 'text-green-600' : 'text-red-600'}>
                        最近测试{provider.lastTestSuccess ? '成功' : '失败'}
                      </span>
                      {provider.avgLatencyMs && (
                        <span className="text-gray-500 ml-1">· {provider.avgLatencyMs}ms</span>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2 pt-2">
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={() => handleTestProvider(provider.id)}
                      disabled={testingProviderId === provider.id}
                      className="gap-1"
                    >
                      {testingProviderId === provider.id ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          测试中
                        </>
                      ) : (
                        <>
                          <Wifi className="h-4 w-4" />
                          测试连接
                        </>
                      )}
                    </Button>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={() => handleToggle(provider)}
                    >
                      <Power className="h-4 w-4" />
                    </Button>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={() => handleEdit(provider)}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      onClick={() => handleDelete(provider.id)}
                    >
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
