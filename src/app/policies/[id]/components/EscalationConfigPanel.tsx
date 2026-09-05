'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
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
  Shield,
  AlertTriangle,
  ArrowUpCircle,
  ArrowDownCircle,
  Clock,
  Save,
  Loader2,
  Info,
} from 'lucide-react';
import { csrfHeaders } from '@/lib/auth/csrf-client';

interface EscalationConfigPanelProps {
  policyId: string;
}

interface EscalationConfig {
  escalationEnabled: boolean;
  escalationThreshold: number;
  escalationTargetPolicyId: string | null;
  deescalationThreshold: number;
  escalationCooldownMinutes: number;
}

interface Policy {
  id: string;
  name: string;
  isDefault: boolean;
}

const DEFAULT_CONFIG: EscalationConfig = {
  escalationEnabled: false,
  escalationThreshold: 5,
  escalationTargetPolicyId: null,
  deescalationThreshold: 1,
  escalationCooldownMinutes: 30,
};

export function EscalationConfigPanel({ policyId }: EscalationConfigPanelProps) {
  const [config, setConfig] = useState<EscalationConfig>(DEFAULT_CONFIG);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 加载策略升级配置
  const loadConfig = async () => {
    try {
      const response = await fetch(`/api/policies/${policyId}/escalation`);
      const data = await response.json();
      if (data.success) {
        setConfig({
          escalationEnabled: data.data?.escalationEnabled ?? false,
          escalationThreshold: data.data?.escalationThreshold ?? 5,
          escalationTargetPolicyId: data.data?.escalationTargetPolicyId ?? null,
          deescalationThreshold: data.data?.deescalationThreshold ?? 1,
          escalationCooldownMinutes: data.data?.escalationCooldownMinutes ?? 30,
        });
      }
    } catch (error) {
      console.error('加载策略升级配置失败:', error);
    } finally {
      setLoading(false);
    }
  };

  // 加载其他策略列表（用于选择升级目标）
  const loadPolicies = async () => {
    try {
      const response = await fetch('/api/policies');
      const data = await response.json();
      if (data.success) {
        // 过滤掉当前策略
        setPolicies(data.data.filter((p: Policy) => p.id !== policyId));
      }
    } catch (error) {
      console.error('加载策略列表失败:', error);
    }
  };

  useEffect(() => {
    loadConfig();
    loadPolicies();
  }, [policyId]);

  // 保存配置
  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/policies/${policyId}/escalation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify(config),
      });

      const data = await response.json();
      if (data.success) {
        toast.success('策略升级配置已保存');
      } else {
        toast.error('保存失败: ' + data.error);
      }
    } catch (error) {
      toast.error('保存失败: 网络错误');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 功能说明 */}
      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="pt-4">
          <div className="flex gap-3">
            <Info className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-800 space-y-1">
              <p className="font-medium">策略自动升级功能</p>
              <p>当用户连续触发警告达到设定次数时，系统会自动将其策略升级为更严格的版本。</p>
              <p>升级后，用户需要连续正常使用（无警告）达到降级次数才会恢复原策略。</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 基础配置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            基础配置
          </CardTitle>
          <CardDescription>启用或禁用策略自动升级功能</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-base">启用策略自动升级</Label>
              <p className="text-sm text-muted-foreground">
                开启后，用户连续触发警告时将自动升级策略
              </p>
            </div>
            <Switch
              checked={config.escalationEnabled}
              onCheckedChange={(checked) =>
                setConfig({ ...config, escalationEnabled: checked })
              }
            />
          </div>
        </CardContent>
      </Card>

      {config.escalationEnabled && (
        <>
          {/* 升级配置 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowUpCircle className="h-5 w-5 text-orange-600" />
                升级配置
              </CardTitle>
              <CardDescription>设置策略升级的触发条件</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="escalationThreshold">
                    升级阈值（连续警告次数）
                  </Label>
                  <Input
                    id="escalationThreshold"
                    type="number"
                    min={1}
                    max={20}
                    value={config.escalationThreshold}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        escalationThreshold: parseInt(e.target.value) || 5,
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    用户连续触发警告达到此次数时升级策略
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="escalationTargetPolicyId">
                    升级目标策略
                  </Label>
                  <Select
                    value={config.escalationTargetPolicyId || 'auto'}
                    onValueChange={(value) =>
                      setConfig({
                        ...config,
                        escalationTargetPolicyId: value === 'auto' ? null : value,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择升级后的策略" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">
                        自动选择（系统严格策略）
                      </SelectItem>
                      {policies.map((policy) => (
                        <SelectItem key={policy.id} value={policy.id}>
                          {policy.name}
                          {policy.isDefault && '（默认）'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    选择升级后使用的策略，留空则自动选择严格策略
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 降级配置 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowDownCircle className="h-5 w-5 text-green-600" />
                降级配置
              </CardTitle>
              <CardDescription>设置策略降级的恢复条件</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="deescalationThreshold">
                    降级阈值（连续放行次数）
                  </Label>
                  <Input
                    id="deescalationThreshold"
                    type="number"
                    min={1}
                    max={10}
                    value={config.deescalationThreshold}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        deescalationThreshold: parseInt(e.target.value) || 1,
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    升级后，用户连续正常使用达到此次数时恢复原策略
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="escalationCooldownMinutes">
                    升级冷却期（分钟）
                  </Label>
                  <Input
                    id="escalationCooldownMinutes"
                    type="number"
                    min={0}
                    max={1440}
                    value={config.escalationCooldownMinutes}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      setConfig({
                        ...config,
                        escalationCooldownMinutes: isNaN(val) ? 30 : val,
                      });
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    升级后在此时间内不会自动降级（0表示无冷却期）
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 提示预览 */}
          <Card className="border-orange-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-orange-600" />
                用户提示预览
              </CardTitle>
              <CardDescription>用户看到的升级/降级提示</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg">
                <div className="flex items-center gap-2 text-sm font-medium text-orange-800">
                  <AlertTriangle className="h-4 w-4" />
                  升级提示
                </div>
                <p className="text-sm text-orange-700 mt-1">
                  您已升级为严格策略，请文明合规使用AI
                </p>
              </div>
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center gap-2 text-sm font-medium text-green-800">
                  <ArrowDownCircle className="h-4 w-4" />
                  降级提示
                </div>
                <p className="text-sm text-green-700 mt-1">
                  您已恢复宽容策略，请继续文明合规使用AI
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* 保存按钮 */}
      <div className="flex justify-end">
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
