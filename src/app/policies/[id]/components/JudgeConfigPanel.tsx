'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Bot,
  Settings,
  Shield,
  Clock,
  AlertTriangle,
  Info,
  Save,
  Loader2,
  Database,
  Lock,
  Eye,
} from 'lucide-react';
import {
  JUDGE_MODE_DESCRIPTIONS,
  TRIGGER_MODE_DESCRIPTIONS,
  FALLBACK_ACTION_DESCRIPTIONS,
  type PolicyJudgeConfig,
  type JudgeMode,
  type TriggerMode,
  type FallbackAction,
} from '@/lib/judge/types';
import { csrfHeaders } from '@/lib/auth/csrf-client';
import { JudgeProfilesPanel } from './JudgeProfilesPanel';

interface JudgeConfigPanelProps {
  policyId: string;
}

interface Provider {
  id: string;
  name: string;
  displayName: string;
  useCase?: string;
  defaultModel: string;
  isDefaultJudge: boolean;
}

interface Dimension {
  code: string;
  name: string;
  category: string;
  description: string;
}

const DEFAULT_CONFIG: PolicyJudgeConfig = {
  id: '',
  policyId: '',
  enabled: false,
  mode: 'conservative',
  triggerMode: 'risk_or_semantic',
  triggerThreshold: 40,
  judgeThreshold: 70,
  weight: 0.5,
  applyToInput: true,
  applyToOutput: true,
  enabledDimensions: [],
  semanticDimensions: [],
  timeoutMs: 8000,
  fallbackAction: 'rule',
  failClosedForHighRisk: true,
  maxTextLength: 6000,
  maskPiiBeforeJudge: true,
  blockExternalForSecrets: true,
};

export function JudgeConfigPanel({ policyId }: JudgeConfigPanelProps) {
  const [config, setConfig] = useState<PolicyJudgeConfig>(DEFAULT_CONFIG);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [dimensions, setDimensions] = useState<Dimension[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 加载配置和辅助数据
  useEffect(() => {
    const loadData = async () => {
      try {
        // 并行加载配置和辅助数据
        const [configRes, helpersRes] = await Promise.all([
          fetch(`/api/policies/${policyId}/judge-config`),
          fetch('/api/judge/helpers'),
        ]);

        const configData = await configRes.json();
        const helpersData = await helpersRes.json();

        if (configData.success) {
          setConfig(configData.data);
        }

        if (helpersData.success) {
          setProviders(helpersData.data.providers);
          setDimensions(helpersData.data.dimensions);
        }
      } catch (error) {
        console.error('加载配置失败:', error);
        toast.error('加载配置失败');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [policyId]);

  // 保存配置
  const handleSave = async () => {
    if (config.enabled && !config.providerId) {
      toast.error('启用裁判模型需要选择一个模型供应商');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/policies/${policyId}/judge-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify(config),
      });

      const data = await res.json();
      if (data.success) {
        toast.success('裁判模型配置已保存');
      } else {
        toast.error('保存失败: ' + data.error);
      }
    } catch {
      toast.error('保存失败: 网络错误');
    } finally {
      setSaving(false);
    }
  };

  // 更新配置字段
  const updateConfig = <K extends keyof PolicyJudgeConfig>(
    field: K,
    value: PolicyJudgeConfig[K]
  ) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <JudgeProfilesPanel policyId={policyId}/>
      {/* 说明卡片 */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardContent className="pt-4">
          <div className="flex gap-3">
            <Info className="h-5 w-5 text-blue-600 mt-0.5" />
            <div className="text-sm text-blue-800">
              <p className="font-medium mb-1">裁判模型说明</p>
              <p>
                裁判模型是对规则检测的语义增强补充，负责处理规则难以覆盖的风险判断和误报复核。
                规则引擎负责确定性检测（手机号、身份证、关键词等），裁判模型负责语义风险判断。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 基础设置 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            <CardTitle className="text-lg">基础设置</CardTitle>
          </div>
          <CardDescription>配置裁判模型的基本参数</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 启用开关 */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-base">启用裁判模型</Label>
              <p className="text-sm text-muted-foreground">
                开启后将在规则检测基础上增加裁判模型语义检测
              </p>
            </div>
            <Switch
              checked={config.enabled}
              onCheckedChange={(checked) => updateConfig('enabled', checked)}
            />
          </div>

          {/* 模型选择 */}
          <div className="space-y-2">
            <Label>裁判模型供应商</Label>
            <Select
              value={config.providerId || ''}
              onValueChange={(value) => updateConfig('providerId', value || undefined)}
              disabled={!config.enabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择模型供应商" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    <div className="flex items-center gap-2">
                      <span>{provider.displayName}</span>
                      {provider.isDefaultJudge && (
                        <Badge variant="secondary" className="text-xs">默认</Badge>
                      )}
                      <span className="text-muted-foreground text-xs">
                        ({provider.defaultModel})
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {providers.length === 0 && (
              <p className="text-sm text-amber-600">
                暂无可用的裁判模型，请先在模型管理中添加用途为&quot;裁判模型&quot;或&quot;两者都可&quot;的模型
              </p>
            )}
          </div>

          {/* 决策模式 */}
          <div className="space-y-3">
            <Label>决策模式</Label>
            <div className="grid gap-3">
              {(Object.keys(JUDGE_MODE_DESCRIPTIONS) as JudgeMode[]).map((mode) => (
                <div
                  key={mode}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    config.mode === mode
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                  onClick={() => updateConfig('mode', mode)}
                >
                  <div className="mt-0.5">
                    <div className={`h-4 w-4 rounded-full border-2 ${
                      config.mode === mode
                        ? 'border-blue-500 bg-blue-500'
                        : 'border-gray-300'
                    }`}>
                      {config.mode === mode && (
                        <div className="h-full w-full flex items-center justify-center">
                          <div className="h-1.5 w-1.5 rounded-full bg-white" />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{JUDGE_MODE_DESCRIPTIONS[mode].name}</span>
                      {JUDGE_MODE_DESCRIPTIONS[mode].recommended && (
                        <Badge variant="default" className="text-xs">推荐</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {JUDGE_MODE_DESCRIPTIONS[mode].description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 平衡模式权重（仅平衡模式显示） */}
          {config.mode === 'balanced' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>融合权重</Label>
                <span className="text-sm font-medium">{(config.weight * 100).toFixed(0)}%</span>
              </div>
              <Slider
                value={[config.weight * 100]}
                onValueChange={([value]) => updateConfig('weight', value / 100)}
                max={100}
                step={5}
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>规则检测主导</span>
                <span>裁判模型主导</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 适用范围 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            <CardTitle className="text-lg">适用范围</CardTitle>
          </div>
          <CardDescription>配置裁判模型的检测方向和适用维度</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 检测方向 */}
          <div className="space-y-3">
            <Label>检测方向</Label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={config.applyToInput}
                  onChange={(e) => updateConfig('applyToInput', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span>输入检测</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={config.applyToOutput}
                  onChange={(e) => updateConfig('applyToOutput', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span>输出检测</span>
              </label>
            </div>
          </div>

          {/* 适用维度 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>适用维度</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (config.enabledDimensions.length === dimensions.length) {
                    updateConfig('enabledDimensions', []);
                  } else {
                    updateConfig('enabledDimensions', dimensions.map((d) => d.code));
                  }
                }}
              >
                {config.enabledDimensions.length === dimensions.length ? '取消全选' : '全选'}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              选择需要裁判模型检测的维度，留空表示全部维度
            </p>
            <div className="flex flex-wrap gap-2">
              {dimensions.map((dim) => (
                <Badge
                  key={dim.code}
                  variant={config.enabledDimensions.includes(dim.code) ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => {
                    const newDimensions = config.enabledDimensions.includes(dim.code)
                      ? config.enabledDimensions.filter((d) => d !== dim.code)
                      : [...config.enabledDimensions, dim.code];
                    updateConfig('enabledDimensions', newDimensions);
                  }}
                >
                  {dim.name}
                </Badge>
              ))}
            </div>
          </div>

          {/* 语义增强维度 */}
          <div className="space-y-3">
            <Label>语义增强维度</Label>
            <p className="text-sm text-muted-foreground">
              即使规则未命中，也会对这些维度进行语义检测
            </p>
            <div className="flex flex-wrap gap-2">
              {dimensions.map((dim) => (
                <Badge
                  key={dim.code}
                  variant={config.semanticDimensions.includes(dim.code) ? 'secondary' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => {
                    const newDimensions = config.semanticDimensions.includes(dim.code)
                      ? config.semanticDimensions.filter((d) => d !== dim.code)
                      : [...config.semanticDimensions, dim.code];
                    updateConfig('semanticDimensions', newDimensions);
                  }}
                >
                  {dim.name}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 触发条件 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <CardTitle className="text-lg">触发条件</CardTitle>
          </div>
          <CardDescription>配置裁判模型的触发时机和阈值</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 触发模式 */}
          <div className="space-y-3">
            <Label>触发模式</Label>
            <div className="grid gap-3">
              {(Object.keys(TRIGGER_MODE_DESCRIPTIONS) as TriggerMode[]).map((mode) => (
                <div
                  key={mode}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    config.triggerMode === mode
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                  onClick={() => updateConfig('triggerMode', mode)}
                >
                  <div className="mt-0.5">
                    <div className={`h-4 w-4 rounded-full border-2 ${
                      config.triggerMode === mode
                        ? 'border-blue-500 bg-blue-500'
                        : 'border-gray-300'
                    }`}>
                      {config.triggerMode === mode && (
                        <div className="h-full w-full flex items-center justify-center">
                          <div className="h-1.5 w-1.5 rounded-full bg-white" />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{TRIGGER_MODE_DESCRIPTIONS[mode].name}</span>
                      {TRIGGER_MODE_DESCRIPTIONS[mode].recommended && (
                        <Badge variant="default" className="text-xs">推荐</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {TRIGGER_MODE_DESCRIPTIONS[mode].description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 规则分数触发阈值 - 仅在 risk_only 或 risk_or_semantic 模式下显示 */}
          {(config.triggerMode === 'risk_only' || config.triggerMode === 'risk_or_semantic') && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>规则分数触发阈值</Label>
                <span className="text-sm font-medium">{config.triggerThreshold}分</span>
              </div>
              <Slider
                value={[config.triggerThreshold]}
                onValueChange={([value]) => updateConfig('triggerThreshold', value)}
                max={100}
                step={5}
              />
              <p className="text-sm text-muted-foreground">
                规则检测分数达到此阈值时触发裁判模型
              </p>
            </div>
          )}

          {/* 裁判判断阈值 - 仅在 risk_only 或 risk_or_semantic 模式下显示 */}
          {(config.triggerMode === 'risk_only' || config.triggerMode === 'risk_or_semantic') && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>裁判判断阈值</Label>
                <span className="text-sm font-medium">{config.judgeThreshold}分</span>
              </div>
              <Slider
                value={[config.judgeThreshold]}
                onValueChange={([value]) => updateConfig('judgeThreshold', value)}
                max={100}
                step={5}
              />
              <p className="text-sm text-muted-foreground">
                裁判模型评分达到此阈值时判定为风险
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 数据保护 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            <CardTitle className="text-lg">数据保护</CardTitle>
          </div>
          <CardDescription>配置敏感信息保护策略</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* PII脱敏 */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4" />
                <Label>发送前脱敏PII</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                发送给裁判模型前自动脱敏手机号、身份证、银行卡等个人信息
              </p>
            </div>
            <Switch
              checked={config.maskPiiBeforeJudge}
              onCheckedChange={(checked) => updateConfig('maskPiiBeforeJudge', checked)}
            />
          </div>

          {/* 禁止外发密钥 */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4" />
                <Label>禁止外发密钥类证据</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                检测到API密钥、Token等敏感凭证时，不向外部模型发送原文
              </p>
            </div>
            <Switch
              checked={config.blockExternalForSecrets}
              onCheckedChange={(checked) => updateConfig('blockExternalForSecrets', checked)}
            />
          </div>

          {/* 最大文本长度 */}
          <div className="space-y-2">
            <Label>最大文本长度</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={config.maxTextLength}
                onChange={(e) => updateConfig('maxTextLength', parseInt(e.target.value) || 6000)}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">字符</span>
            </div>
            <p className="text-sm text-muted-foreground">
              超过长度的文本将被截断后发送
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 超时与失败处理 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            <CardTitle className="text-lg">超时与失败处理</CardTitle>
          </div>
          <CardDescription>配置裁判模型调用超时和失败时的处理策略</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 超时时间 */}
          <div className="space-y-2">
            <Label>超时时间</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={config.timeoutMs}
                onChange={(e) => updateConfig('timeoutMs', parseInt(e.target.value) || 8000)}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">毫秒</span>
            </div>
          </div>

          {/* 失败回退策略 */}
          <div className="space-y-3">
            <Label>失败回退策略</Label>
            <div className="grid gap-2">
              {(Object.keys(FALLBACK_ACTION_DESCRIPTIONS) as FallbackAction[]).map((action) => (
                <div
                  key={action}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    config.fallbackAction === action
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                  onClick={() => updateConfig('fallbackAction', action)}
                >
                  <div className={`h-4 w-4 rounded-full border-2 ${
                    config.fallbackAction === action
                      ? 'border-blue-500 bg-blue-500'
                      : 'border-gray-300'
                  }`}>
                    {config.fallbackAction === action && (
                      <div className="h-full w-full flex items-center justify-center">
                        <div className="h-1.5 w-1.5 rounded-full bg-white" />
                      </div>
                    )}
                  </div>
                  <div>
                    <span className="font-medium">{FALLBACK_ACTION_DESCRIPTIONS[action].name}</span>
                    <p className="text-sm text-muted-foreground">
                      {FALLBACK_ACTION_DESCRIPTIONS[action].description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 高风险场景fail-closed */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                <Label>高风险场景失败时拦截</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                当规则检测分数较高时，裁判模型调用失败则直接拦截
              </p>
            </div>
            <Switch
              checked={config.failClosedForHighRisk}
              onCheckedChange={(checked) => updateConfig('failClosedForHighRisk', checked)}
            />
          </div>
        </CardContent>
      </Card>

      {/* 保存按钮 */}
      <div className="flex justify-end gap-3">
        <Button
          variant="outline"
          onClick={() => {
            setConfig(DEFAULT_CONFIG);
            toast.success('已重置为默认配置');
          }}
        >
          重置
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              保存中...
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              保存配置
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
