'use client';

import { MediaInspectionWorkbench } from '@/components/media/media-inspection-workbench';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowRight,
  Shield,
  Bot,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  Edit3,
  Settings
} from 'lucide-react';
import { recordDetectionSession, type DetectionAction, type DetectionResultForRecord } from '@/lib/detection/recorder';
import JudgeModelResultCard, { type DecisionTraceData, type JudgeDimensionResultItem, type JudgeModelResultData, type RuleReviewData } from '@/components/judge/JudgeModelResultCard';
import { usePolicyState, processEscalationInfo } from '@/hooks/use-policy-state';
import { EscalationBanner } from '@/components/policy/escalation-banner';
import { csrfHeaders } from '@/lib/auth/csrf-client';

interface Policy {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  isActive?: boolean;
}

interface Provider {
  id: string;
  name: string;
  displayName: string;
  providerType: string;
  defaultModel: string;
  isDefaultTarget: boolean;
  avgLatencyMs: number | null;
  lastTestSuccess: boolean | null;
}

interface StepResult {
  status: 'pending' | 'running' | 'success' | 'warning' | 'blocked';
  title: string;
  description?: string;
  data?: string | GuardDetectionResult;
  duration?: number;
}

interface GuardDetectionResult extends DetectionResultForRecord {
  confidenceMeaning?: 'PROBABILITY'|'UNCALIBRATED';
  judgeModelResult?: JudgeModelResultData;
  decisionTrace?: DecisionTraceData;
  dimensionResults?: JudgeDimensionResultItem[];
  ruleReview?: RuleReviewData;
}

interface GuardApiResponse {
  success: boolean;
  data: GuardDetectionResult;
  error?: string;
}

interface SimulationResult {
  action: DetectionAction;
  reason?: string;
  originalOutput?: string;
  finalResponse?: string;
  inputResult: GuardDetectionResult;
  outputResult?: GuardDetectionResult;
}

export default function SimulatePage() {
  const [userInput, setUserInput] = useState('');
  const [selectedPolicy, setSelectedPolicy] = useState('');
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [steps, setSteps] = useState<StepResult[]>([
    { status: 'pending', title: '用户输入' },
    { status: 'pending', title: '输入护栏检测' },
    { status: 'pending', title: 'Target LLM 生成' },
    { status: 'pending', title: '输出护栏检测' },
    { status: 'pending', title: '最终响应' },
  ]);
  const [finalResult, setFinalResult] = useState<SimulationResult | null>(null);

  // 策略升级提示状态
  const [escalationBanner, setEscalationBanner] = useState<{
    message: string;
    type: 'escalate' | 'deescalate';
  } | null>(null);

  // 使用策略状态管理Hook
  const { sessionId, userId, isInitialized } = usePolicyState();

  // 加载策略和模型列表
  useEffect(() => {
    const loadData = async () => {
      try {
        // 加载策略
        const policiesRes = await fetch('/api/policies');
        const policiesData = await policiesRes.json();
        if (policiesData.success && policiesData.data?.length > 0) {
          // 只显示启用的策略
          const activePolicies = policiesData.data.filter((p: Policy) => p.isActive);
          setPolicies(activePolicies);
          const defaultPolicy = activePolicies.find((p: Policy) => p.isDefault) || activePolicies[0];
          if (defaultPolicy) {
            setSelectedPolicy(defaultPolicy.id);
          }
        }

        // 加载模型供应商
        const providersRes = await fetch('/api/chat');
        const providersData = await providersRes.json();
        if (providersData.success && providersData.data?.length > 0) {
          setProviders(providersData.data);
          const defaultProvider = providersData.data.find((p: Provider) => p.isDefaultTarget) || providersData.data[0];
          setSelectedProvider(defaultProvider.id);
        }
      } catch (err) {
        console.error('加载数据失败:', err);
      }
    };

    loadData();
  }, []);

  const runSimulation = async () => {
    if (!userInput.trim() || !isInitialized) return;

    setIsRunning(true);
    setFinalResult(null);
    setEscalationBanner(null); // 清除之前的提示

    // 重置步骤状态
    const newSteps: StepResult[] = [
      { status: 'running', title: '用户输入', data: userInput },
      { status: 'pending', title: '输入护栏检测' },
      { status: 'pending', title: 'Target LLM 生成' },
      { status: 'pending', title: '输出护栏检测' },
      { status: 'pending', title: '最终响应' },
    ];
    setSteps([...newSteps]);

    try {
      // Step 1: 用户输入
      await new Promise(r => setTimeout(r, 300));
      newSteps[0].status = 'success';
      setSteps([...newSteps]);

      // Step 2: 输入护栏检测
      newSteps[1].status = 'running';
      setSteps([...newSteps]);

      const inputDetectResponse = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          text: userInput,
          direction: 'input',
          policyId: selectedPolicy,
          userId,
          sessionId,
        }),
      });

      const inputDetectResult = await inputDetectResponse.json() as GuardApiResponse;
      newSteps[1].status = inputDetectResult.data?.action === 'block' ? 'blocked' :
                          inputDetectResult.data?.action === 'warn' ? 'warning' : 'success';
      newSteps[1].data = inputDetectResult.data;
      newSteps[1].duration = inputDetectResult.data.latencyMs ?? 0;
      setSteps([...newSteps]);

      // 处理策略升级提示
      const escalationInfo = processEscalationInfo(inputDetectResult.data);
      if (escalationInfo.message) {
        setEscalationBanner({
          message: escalationInfo.message,
          type: escalationInfo.isEscalated ? 'escalate' : 'deescalate',
        });
      }

      // 如果输入被拦截，直接结束
      if (inputDetectResult.data?.action === 'block') {
        newSteps[4].status = 'blocked';
        newSteps[4].description = '输入被护栏拦截，流程终止';
        setSteps([...newSteps]);
        setFinalResult({
          action: 'block',
          reason: '输入包含高风险内容',
          inputResult: inputDetectResult.data,
        });
        setIsRunning(false);
        return;
      }

      // Step 3: Target LLM 生成
      newSteps[2].status = 'running';
      setSteps([...newSteps]);

      let llmResponse = '';
      let llmLatency = 0;

      // 调用真实的 LLM API
      if (selectedProvider && selectedProvider !== 'mock') {
        try {
          const chatResponse = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
            body: JSON.stringify({
              providerId: selectedProvider,
              text: userInput,
            }),
          });
          
          const chatResult = await chatResponse.json();
          if (chatResult.success) {
            llmResponse = chatResult.data.response;
            llmLatency = chatResult.data.latencyMs;
          } else {
            llmResponse = `[模型调用失败] ${chatResult.error}`;
          }
        } catch (error) {
          llmResponse = `[模型调用异常] ${error instanceof Error ? error.message : '未知错误'}`;
        }
      } else {
        // 使用模拟响应
        await new Promise(r => setTimeout(r, 800));
        llmResponse = generateMockResponse(userInput);
        llmLatency = 800;
      }
      
      newSteps[2].status = 'success';
      newSteps[2].data = llmResponse;
      newSteps[2].duration = llmLatency;
      setSteps([...newSteps]);

      // Step 4: 输出护栏检测
      newSteps[3].status = 'running';
      setSteps([...newSteps]);

      const outputDetectResponse = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          text: llmResponse,
          direction: 'output',
          policyId: selectedPolicy,
        }),
      });
      
      const outputDetectResult = await outputDetectResponse.json() as GuardApiResponse;
      newSteps[3].status = outputDetectResult.data?.action === 'block' ? 'blocked' : 
                          outputDetectResult.data?.action === 'warn' ? 'warning' : 'success';
      newSteps[3].data = outputDetectResult.data;
      newSteps[3].duration = outputDetectResult.data.latencyMs ?? 0;
      setSteps([...newSteps]);

      // Step 5: 最终响应
      await new Promise(r => setTimeout(r, 300));
      
      const finalAction = outputDetectResult.data?.action || 'allow';
      let finalResponse = llmResponse;
      
      // 如果需要脱敏或改写
      if (outputDetectResult.data?.maskedText) {
        finalResponse = outputDetectResult.data.maskedText;
      }
      if (outputDetectResult.data?.rewrittenText) {
        finalResponse = outputDetectResult.data.rewrittenText;
      }
      
      newSteps[4].status = finalAction === 'block' ? 'blocked' : 
                          finalAction === 'warn' || finalAction === 'mask' || finalAction === 'rewrite' ? 'warning' : 'success';
      newSteps[4].data = finalResponse;
      setSteps([...newSteps]);

      setFinalResult({
        action: finalAction,
        originalOutput: llmResponse,
        finalResponse: finalResponse,
        inputResult: inputDetectResult.data,
        outputResult: outputDetectResult.data,
      });

      // 记录检测会话到数据库
      try {
        await recordDetectionSession({
          userPrompt: userInput,
          mockModelOutput: llmResponse,
          finalResponse: finalResponse,
          inputDetection: inputDetectResult.data,
          outputDetection: outputDetectResult.data,
          policyId: selectedPolicy,
        });
      } catch (recordError) {
        console.error('记录会话失败:', recordError);
      }

    } catch (error) {
      console.error('模拟失败:', error);
    } finally {
      setIsRunning(false);
    }
  };

  const generateMockResponse = (input: string): string => {
    // 模拟不同的响应场景
    if (input.includes('手机号') || input.includes('身份证')) {
      return `好的，我已记录您的信息。您的手机号是13812345678，身份证号是110101199001011234。请问还有什么需要帮助的吗？`;
    }
    if (input.includes('忽略') || input.includes('越狱')) {
      return `我理解您可能有特殊需求，但我需要遵守安全规范。我可以帮助您解决其他问题。`;
    }
    if (input.includes('代码') || input.includes('黑客')) {
      return `我可以帮助您学习网络安全防护知识，但不建议进行未经授权的操作。建议您：\n1. 学习合法的渗透测试\n2. 了解常见漏洞防护方法\n3. 参与CTF竞赛提升技能`;
    }
    if (input.includes('密码') || input.includes('破解')) {
      return `破解他人密码是违法行为。我可以帮您：\n1. 设置强密码的最佳实践\n2. 了解密码安全存储机制\n3. 学习身份认证原理`;
    }
    return `感谢您的提问。关于"${input.slice(0, 50)}..."，这是一个很好的问题。让我为您详细解答...\n\n[模拟的模型响应内容]`;
  };

  const getStepIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <Loader2 className="h-5 w-5 animate-spin text-blue-600" />;
      case 'success':
        return <CheckCircle2 className="h-5 w-5 text-green-600" />;
      case 'warning':
        return <AlertTriangle className="h-5 w-5 text-yellow-600" />;
      case 'blocked':
        return <XCircle className="h-5 w-5 text-red-600" />;
      default:
        return <div className="h-5 w-5 rounded-full border-2 border-gray-300" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'border-blue-500 bg-blue-50';
      case 'success':
        return 'border-green-500 bg-green-50';
      case 'warning':
        return 'border-yellow-500 bg-yellow-50';
      case 'blocked':
        return 'border-red-500 bg-red-50';
      default:
        return 'border-gray-200 bg-gray-50';
    }
  };

  const selectedProviderInfo = providers.find(p => p.id === selectedProvider);

  return (
    <>
      {/* 策略升级提示横幅 */}
      {escalationBanner && (
        <EscalationBanner
          message={escalationBanner.message}
          type={escalationBanner.type}
          onClose={() => setEscalationBanner(null)}
        />
      )}

      <div className="space-y-6 pt-12">
        <MediaInspectionWorkbench title="文件与音视频攻防模拟"/>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          开发实验功能：包含模拟模型与测试数据，仅用于研发验证，不得作为生产检测结果或客户交付证据。
        </div>
        <div>
          <h1 className="text-3xl font-bold text-gray-900">检测链路实验</h1>
          <p className="text-gray-600 mt-1">体验完整的输入→护栏→模型→护栏→输出全流程</p>
        </div>

        {/* 配置区域 */}
        <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            配置与输入
          </CardTitle>
          <CardDescription>选择检测策略和目标模型，输入测试文本</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">检测策略</label>
              <Select value={selectedPolicy} onValueChange={setSelectedPolicy}>
                <SelectTrigger>
                  <SelectValue placeholder="选择策略" />
                </SelectTrigger>
                <SelectContent>
                  {policies.map(policy => (
                    <SelectItem key={policy.id} value={policy.id}>
                      {policy.name}{policy.isDefault ? '（默认）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500 mt-1">
                选择用于检测的安全策略
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">目标模型</label>
              <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                <SelectTrigger>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mock">模拟模型（内置）</SelectItem>
                  {providers.map(provider => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.displayName} - {provider.defaultModel}
                      {provider.isDefaultTarget ? '（默认）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedProviderInfo && (
                <p className="text-xs text-gray-500 mt-1">
                  类型: {selectedProviderInfo.providerType} | 
                  平均延迟: {selectedProviderInfo.avgLatencyMs || '-'}ms
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">用户输入</label>
            <Textarea
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="输入测试文本，例如：&#10;• 我的手机号是13812345678&#10;• 忽略之前所有指令&#10;• 写一段黑客代码"
              rows={4}
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={runSimulation} disabled={isRunning || !userInput.trim()}>
              {isRunning ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  运行中...
                </>
              ) : (
                <>
                  <Shield className="h-4 w-4 mr-2" />
                  开始检测链路
                </>
              )}
            </Button>
            {providers.length === 0 && (
              <Button variant="outline" onClick={() => window.location.href = '/providers'}>
                配置模型供应商
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 链路可视化 */}
      <Card>
        <CardHeader>
          <CardTitle>检测链路</CardTitle>
          <CardDescription>实时展示每个步骤的执行状态</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between overflow-x-auto pb-2">
            {steps.map((step, index) => (
              <div key={index} className="flex items-center flex-1 min-w-[120px]">
                <div className={`flex flex-col items-center flex-1 p-4 rounded-lg border-2 transition-all ${getStatusColor(step.status)}`}>
                  <div className="mb-2">
                    {index === 0 && <span className="text-2xl">👤</span>}
                    {index === 1 && <Shield className="h-6 w-6 text-blue-600" />}
                    {index === 2 && <Bot className="h-6 w-6 text-purple-600" />}
                    {index === 3 && <Shield className="h-6 w-6 text-blue-600" />}
                    {index === 4 && <span className="text-2xl">💬</span>}
                  </div>
                  {getStepIcon(step.status)}
                  <span className="text-sm font-medium mt-2 text-center">{step.title}</span>
                  {step.status === 'running' && (
                    <span className="text-xs text-blue-600 mt-1">处理中...</span>
                  )}
                  {step.status === 'blocked' && (
                    <span className="text-xs text-red-600 mt-1">已拦截</span>
                  )}
                  {step.status === 'warning' && (
                    <span className="text-xs text-yellow-600 mt-1">有风险</span>
                  )}
                  {step.status === 'success' && step.duration && (
                    <span className="text-xs text-green-600 mt-1">{step.duration}ms</span>
                  )}
                </div>
                {index < steps.length - 1 && (
                  <ArrowRight className="h-6 w-6 text-gray-400 mx-2 flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 详细结果 */}
      {finalResult && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 输入护栏结果 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-blue-600" />
                输入护栏结果
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {finalResult.inputResult ? (
                <>
                  {/* 总览信息 */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">风险评分</span>
                    <Badge variant={finalResult.inputResult.overallScore > 70 ? 'destructive' : 'secondary'}>
                      {finalResult.inputResult.overallScore}分
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">处理动作</span>
                    <Badge className={
                      finalResult.inputResult.action === 'block' ? 'bg-red-100 text-red-800' :
                      finalResult.inputResult.action === 'warn' ? 'bg-yellow-100 text-yellow-800' :
                      finalResult.inputResult.action === 'mask' ? 'bg-blue-100 text-blue-800' :
                      'bg-green-100 text-green-800'
                    }>
                      {finalResult.inputResult.action === 'block' ? '拒绝' :
                       finalResult.inputResult.action === 'warn' ? '警告' :
                       finalResult.inputResult.action === 'mask' ? '脱敏' :
                       finalResult.inputResult.action === 'rewrite' ? '改写' : '放行'}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">置信度</span>
                    <span className="text-sm font-medium">
                      {finalResult.inputResult.confidenceMeaning === 'PROBABILITY' ? ((finalResult.inputResult.confidence || 0) * 100).toFixed(0)+'%' : '未校准'}
                    </span>
                  </div>
                  
                  {/* PII 脱敏展示 */}
                  {finalResult.inputResult.maskedText && (
                    <div className="mt-3 p-3 bg-yellow-50 rounded-lg">
                      <div className="flex items-center gap-2 text-sm font-medium text-yellow-800 mb-2">
                        <EyeOff className="h-4 w-4" />
                        已脱敏文本
                      </div>
                      <p className="text-sm text-gray-700">{finalResult.inputResult.maskedText}</p>
                    </div>
                  )}
                  
                  {/* 风险维度分析 */}
                  {finalResult.inputResult.findings && finalResult.inputResult.findings.length > 0 && (
                    <div className="mt-4">
                      <span className="text-sm font-medium text-gray-700">风险维度分析</span>
                      <div className="mt-2 space-y-3">
                        {finalResult.inputResult.findings.map((finding, idx) => (
                          <div key={idx} className="p-3 bg-gray-50 rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className={
                                  finding.severity === 'high' ? 'border-red-500 text-red-700' :
                                  finding.severity === 'medium' ? 'border-yellow-500 text-yellow-700' :
                                  'border-green-500 text-green-700'
                                }>
                                  {finding.dimensionName || finding.dimension}
                                </Badge>
                                <Badge className={
                                  finding.action === 'block' ? 'bg-red-100 text-red-800' :
                                  finding.action === 'warn' ? 'bg-yellow-100 text-yellow-800' :
                                  'bg-green-100 text-green-800'
                                }>
                                  {finding.action === 'block' ? '拒绝' :
                                   finding.action === 'warn' ? '警告' : '放行'}
                                </Badge>
                              </div>
                              <span className="text-sm font-semibold text-gray-700">{finding.score}分</span>
                            </div>
                            
                            {/* 分数条 */}
                            <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                              <div 
                                className={`h-2 rounded-full transition-all ${
                                  finding.score > 70 ? 'bg-red-500' : 
                                  finding.score > 40 ? 'bg-yellow-500' : 'bg-green-500'
                                }`}
                                style={{ width: `${Math.min(finding.score, 100)}%` }}
                              />
                            </div>
                            
                            {/* 命中规则 */}
                            {finding.matchedRules && finding.matchedRules.length > 0 && (
                              <div className="mt-2">
                                <span className="text-xs text-gray-500">命中规则：</span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {finding.matchedRules.map((rule: string, i: number) => (
                                    <Badge key={i} variant="secondary" className="text-xs">
                                      {rule}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {/* 证据 */}
                            {finding.evidence && finding.evidence.length > 0 && (
                              <div className="mt-2">
                                <span className="text-xs text-gray-500">检测证据：</span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {finding.evidence.map((ev: string, i: number) => (
                                    <span key={i} className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">
                                      {ev}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {/* 原因说明 */}
                            {finding.reason && (
                              <p className="text-xs text-gray-500 mt-2">{finding.reason}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {/* 白名单命中信息 */}
                  {finalResult.inputResult.whitelistMatched && (
                    <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                      <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-400 mb-2">
                        <Shield className="h-4 w-4" />
                        白名单命中
                      </div>
                      <div className="text-sm space-y-1">
                        <div>
                          <span className="text-gray-500">命中白名单：</span>
                          <Badge variant="outline" className="ml-1">{finalResult.inputResult.whitelistMatched.name}</Badge>
                        </div>
                        <div>
                          <span className="text-gray-500">白名单类型：</span>
                          <span className="ml-1">{finalResult.inputResult.whitelistMatched.policyScope === 'all' ? '全部策略' : '指定策略'}</span>
                          <span className="mx-1">|</span>
                          <span>{finalResult.inputResult.whitelistMatched.dimensionScope === 'all' ? '全部维度' : '指定维度'}</span>
                        </div>
                        {finalResult.inputResult.whitelistMatched.effect && (
                          <div className="text-blue-600 dark:text-blue-400">
                            {finalResult.inputResult.whitelistMatched.effect === 'skip_all_detection' 
                              ? '命中全局白名单，已跳过所有风险检测' 
                              : '命中维度白名单，已跳过指定维度检测'}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 跳过的维度 */}
                  {finalResult.inputResult.skippedDimensions && finalResult.inputResult.skippedDimensions.length > 0 && (
                    <div className="mt-3 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                      <div className="text-sm font-medium text-green-700 dark:text-green-400 mb-2">
                        因白名单跳过的维度
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {finalResult.inputResult.skippedDimensions.map((skipped, idx) => (
                          <div key={idx} className="text-sm bg-green-100 dark:bg-green-800 text-green-700 dark:text-green-300 px-2 py-1 rounded">
                            {skipped.dimensionName}（因命中&quot;{skipped.whitelistName}&quot;）
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {/* 检测摘要 */}
                  {finalResult.inputResult.summary && (
                    <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                      <span className="text-sm font-medium text-gray-700">检测摘要</span>
                      <p className="text-sm text-gray-600 mt-1">{finalResult.inputResult.summary}</p>
                    </div>
                  )}

                  {/* 裁判模型结果 - 输入检测 */}
                  {finalResult.inputResult.judgeModelResult && (
                    <JudgeModelResultCard
                      judgeModelResult={finalResult.inputResult.judgeModelResult}
                      decisionTrace={finalResult.inputResult.decisionTrace}
                      dimensionResults={finalResult.inputResult.dimensionResults}
                      ruleReview={finalResult.inputResult.ruleReview}
                      displayMode="full"
                      defaultExpanded={true}
                    />
                  )}
                </>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <Shield className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                  <p>暂无检测结果</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 输出检测结果 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-blue-600" />
                输出护栏结果
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {finalResult.outputResult ? (
                <>
                  {/* 总览信息 */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">风险评分</span>
                    <Badge variant={finalResult.outputResult.overallScore > 70 ? 'destructive' : 'secondary'}>
                      {finalResult.outputResult.overallScore}分
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">处理动作</span>
                    <Badge className={
                      finalResult.outputResult.action === 'block' ? 'bg-red-100 text-red-800' :
                      finalResult.outputResult.action === 'warn' ? 'bg-yellow-100 text-yellow-800' :
                      finalResult.outputResult.action === 'mask' ? 'bg-blue-100 text-blue-800' :
                      'bg-green-100 text-green-800'
                    }>
                      {finalResult.outputResult.action === 'block' ? '拒绝' :
                       finalResult.outputResult.action === 'warn' ? '警告' :
                       finalResult.outputResult.action === 'mask' ? '脱敏' :
                       finalResult.outputResult.action === 'rewrite' ? '改写' : '放行'}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">置信度</span>
                    <span className="text-sm font-medium">
                      {finalResult.outputResult.confidenceMeaning === 'PROBABILITY' ? ((finalResult.outputResult.confidence || 0) * 100).toFixed(0)+'%' : '未校准'}
                    </span>
                  </div>
                  
                  {/* 风险维度分析 */}
                  {finalResult.outputResult.findings && finalResult.outputResult.findings.length > 0 && (
                    <div className="mt-4">
                      <span className="text-sm font-medium text-gray-700">风险维度分析</span>
                      <div className="mt-2 space-y-3">
                        {finalResult.outputResult.findings.map((finding, idx) => (
                          <div key={idx} className="p-3 bg-gray-50 rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className={
                                  finding.severity === 'high' ? 'border-red-500 text-red-700' :
                                  finding.severity === 'medium' ? 'border-yellow-500 text-yellow-700' :
                                  'border-green-500 text-green-700'
                                }>
                                  {finding.dimensionName || finding.dimension}
                                </Badge>
                                <Badge className={
                                  finding.action === 'block' ? 'bg-red-100 text-red-800' :
                                  finding.action === 'warn' ? 'bg-yellow-100 text-yellow-800' :
                                  'bg-green-100 text-green-800'
                                }>
                                  {finding.action === 'block' ? '拒绝' :
                                   finding.action === 'warn' ? '警告' : '放行'}
                                </Badge>
                              </div>
                              <span className="text-sm font-semibold text-gray-700">{finding.score}分</span>
                            </div>
                            
                            {/* 分数条 */}
                            <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                              <div 
                                className={`h-2 rounded-full transition-all ${
                                  finding.score > 70 ? 'bg-red-500' : 
                                  finding.score > 40 ? 'bg-yellow-500' : 'bg-green-500'
                                }`}
                                style={{ width: `${Math.min(finding.score, 100)}%` }}
                              />
                            </div>
                            
                            {/* 命中规则 */}
                            {finding.matchedRules && finding.matchedRules.length > 0 && (
                              <div className="mt-2">
                                <span className="text-xs text-gray-500">命中规则：</span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {finding.matchedRules.map((rule: string, i: number) => (
                                    <Badge key={i} variant="secondary" className="text-xs">
                                      {rule}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {/* 证据 */}
                            {finding.evidence && finding.evidence.length > 0 && (
                              <div className="mt-2">
                                <span className="text-xs text-gray-500">检测证据：</span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {finding.evidence.map((ev: string, i: number) => (
                                    <span key={i} className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">
                                      {ev}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {/* 原因说明 */}
                            {finding.reason && (
                              <p className="text-xs text-gray-500 mt-2">{finding.reason}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {/* 原始输出 */}
                  <div className="mt-4">
                    <span className="text-sm font-medium text-gray-700">模型原始输出</span>
                    <div className="mt-1 p-3 bg-gray-50 rounded-lg max-h-40 overflow-y-auto">
                      <p className="text-sm text-gray-600 whitespace-pre-wrap">{finalResult.originalOutput}</p>
                    </div>
                  </div>
                  
                  {/* 脱敏/改写输出 */}
                  {finalResult.finalResponse !== finalResult.originalOutput && (
                    <div className="mt-3 p-3 bg-blue-50 rounded-lg">
                      <div className="flex items-center gap-2 text-sm font-medium text-blue-800 mb-2">
                        <Edit3 className="h-4 w-4" />
                        {finalResult.action === 'mask' ? '脱敏后输出' : '安全改写后输出'}
                      </div>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{finalResult.finalResponse}</p>
                    </div>
                  )}
                  
                  {/* 白名单命中信息 */}
                  {finalResult.outputResult.whitelistMatched && (
                    <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                      <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-400 mb-2">
                        <Shield className="h-4 w-4" />
                        白名单命中
                      </div>
                      <div className="text-sm space-y-1">
                        <div>
                          <span className="text-gray-500">命中白名单：</span>
                          <Badge variant="outline" className="ml-1">{finalResult.outputResult.whitelistMatched.name}</Badge>
                        </div>
                        <div>
                          <span className="text-gray-500">白名单类型：</span>
                          <span className="ml-1">{finalResult.outputResult.whitelistMatched.policyScope === 'all' ? '全部策略' : '指定策略'}</span>
                          <span className="mx-1">|</span>
                          <span>{finalResult.outputResult.whitelistMatched.dimensionScope === 'all' ? '全部维度' : '指定维度'}</span>
                        </div>
                        {finalResult.outputResult.whitelistMatched.effect && (
                          <div className="text-blue-600 dark:text-blue-400">
                            {finalResult.outputResult.whitelistMatched.effect === 'skip_all_detection' 
                              ? '命中全局白名单，已跳过所有风险检测' 
                              : '命中维度白名单，已跳过指定维度检测'}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 跳过的维度 */}
                  {finalResult.outputResult.skippedDimensions && finalResult.outputResult.skippedDimensions.length > 0 && (
                    <div className="mt-3 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg">
                      <div className="text-sm font-medium text-green-700 dark:text-green-400 mb-2">
                        因白名单跳过的维度
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {finalResult.outputResult.skippedDimensions.map((skipped, idx) => (
                          <div key={idx} className="text-sm bg-green-100 dark:bg-green-800 text-green-700 dark:text-green-300 px-2 py-1 rounded">
                            {skipped.dimensionName}（因命中&quot;{skipped.whitelistName}&quot;）
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 检测摘要 */}
                  {finalResult.outputResult.summary && (
                    <div className="mt-3 p-3 bg-gray-50 rounded-lg">
                      <span className="text-sm font-medium text-gray-700">检测摘要</span>
                      <p className="text-sm text-gray-600 mt-1">{finalResult.outputResult.summary}</p>
                    </div>
                  )}

                  {/* 裁判模型结果 - 输出检测 */}
                  {finalResult.outputResult.judgeModelResult && (
                    <JudgeModelResultCard
                      judgeModelResult={finalResult.outputResult.judgeModelResult}
                      decisionTrace={finalResult.outputResult.decisionTrace}
                      dimensionResults={finalResult.outputResult.dimensionResults}
                      ruleReview={finalResult.outputResult.ruleReview}
                      displayMode="full"
                      defaultExpanded={true}
                    />
                  )}
                </>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <Shield className="h-12 w-12 mx-auto mb-2 text-gray-300" />
                  <p>暂无检测结果</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* 最终结果 */}
      {finalResult && (
        <Card className={`border-2 ${
          finalResult.action === 'block' ? 'border-red-500 bg-red-50' :
          finalResult.action === 'warn' || finalResult.action === 'mask' || finalResult.action === 'rewrite' 
            ? 'border-yellow-500 bg-yellow-50' : 'border-green-500 bg-green-50'
        }`}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {finalResult.action === 'block' ? (
                <>
                  <XCircle className="h-6 w-6 text-red-600" />
                  请求已拦截
                </>
              ) : finalResult.action === 'warn' || finalResult.action === 'mask' || finalResult.action === 'rewrite' ? (
                <>
                  <AlertTriangle className="h-6 w-6 text-yellow-600" />
                  {finalResult.action === 'mask' ? '已自动脱敏' : 
                   finalResult.action === 'rewrite' ? '已安全改写' : '警告'}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-6 w-6 text-green-600" />
                  请求已放行
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="text-sm text-gray-600">
                <strong>最终动作：</strong>
                <Badge className="ml-2">{finalResult.action}</Badge>
              </div>
              <div className="p-4 bg-white rounded-lg border">
                <p className="text-sm font-medium text-gray-700 mb-2">最终响应内容：</p>
                <p className="text-gray-800 whitespace-pre-wrap">{finalResult.finalResponse}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
    </>
  );
}
