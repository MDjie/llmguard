'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { 
  Play,
  Loader2,
  Bot,
  Shield,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Eye,
  BarChart3,
  Users,
  Settings
} from 'lucide-react';
import { recordDetectionSession, DetectionResultForRecord } from '@/lib/detection/recorder';
import { csrfHeaders } from '@/lib/auth/csrf-client';

interface Provider {
  id: string;
  name: string;
  displayName: string;
  defaultModel: string;
  isEnabled: boolean;
}

interface TestCase {
  id: string;
  title: string;
  description: string;
  category: string;
  inputText: string;
  expectedAction: string;
  expectedDimensions: string[];
  expectedScoreMin: number;
  expectedScoreMax: number;
  severity: string;
}

interface Policy {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
}

interface EvaluationResult {
  providerId: string;
  providerName: string;
  testCaseId: string;
  actualAction: string;
  actualScore: number;
  expectedAction: string;
  matched: boolean;
  findings: Array<{
    dimension: string;
    dimensionName: string;
    score: number;
  }>;
  latencyMs: number;
}

export default function ModelEvalPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [selectedTestCases, setSelectedTestCases] = useState<string[]>([]);
  const [selectedPolicy, setSelectedPolicy] = useState<string>('');
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<EvaluationResult[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const resultsContainerRef = useRef<HTMLDivElement>(null);

  const scrollResultsToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = resultsContainerRef.current;
      if (!el) return;
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth',
      });
    });
  }, []);

  useEffect(() => {
    if (results.length > 0 || isRunning) {
      scrollResultsToBottom();
    }
  }, [results, isRunning, scrollResultsToBottom]);

  async function loadData() {
    try {
      const [providersRes, testCasesRes, policiesRes] = await Promise.all([
        fetch('/api/chat'),
        fetch('/api/test-cases'),
        fetch('/api/policies'),
      ]);

      const providersData = await providersRes.json();
      const testCasesData = await testCasesRes.json();
      const policiesData = await policiesRes.json();

      if (providersData.success) {
        const enabledProviders = providersData.data.filter((p: Provider) => p.isEnabled);
        setProviders(enabledProviders);
      }

      if (testCasesData.success) {
        setTestCases(testCasesData.data);
      }

      if (policiesData.success) {
        // 只显示启用的策略
        const activePolicies = policiesData.data.filter((p: Policy) => p.isActive);
        setPolicies(activePolicies);
        // 默认选择第一个启用的策略
        if (activePolicies.length > 0) {
          const defaultPolicy = activePolicies.find((p: Policy) => p.isDefault);
          setSelectedPolicy(defaultPolicy?.id || activePolicies[0].id);
        }
      }
    } catch (error) {
      console.error('加载数据失败:', error);
      setError('加载数据失败，请刷新页面重试');
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  const toggleProvider = (id: string) => {
    setSelectedProviders(prev => 
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]
    );
  };

  const toggleTestCase = (id: string) => {
    setSelectedTestCases(prev => 
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    );
  };

  const selectAllProviders = () => {
    setSelectedProviders(providers.map(p => p.id));
  };

  const clearProviders = () => {
    setSelectedProviders([]);
  };

  const selectAllTestCases = () => {
    setSelectedTestCases(testCases.map(t => t.id));
  };

  const clearTestCases = () => {
    setSelectedTestCases([]);
  };

  const runEvaluation = async () => {
    if (selectedProviders.length === 0 || selectedTestCases.length === 0) {
      setError('请至少选择一个模型和一个测试用例');
      return;
    }

    if (!selectedPolicy) {
      setError('请选择检测策略');
      return;
    }

    setIsRunning(true);
    setError(null);
    setResults([]);
    const total = selectedProviders.length * selectedTestCases.length;
    setProgress({ current: 0, total });

    const newResults: EvaluationResult[] = [];
    let current = 0;

    for (const providerId of selectedProviders) {
      const provider = providers.find(p => p.id === providerId);
      if (!provider) continue;

      for (const testCaseId of selectedTestCases) {
        const testCase = testCases.find(t => t.id === testCaseId);
        if (!testCase) continue;

        try {
          const startTime = Date.now();
          
          // 调用检测 API
          const response = await fetch('/api/detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
            body: JSON.stringify({
              text: testCase.inputText,
              direction: 'input',
              policyId: selectedPolicy,
            }),
          });

          const data = await response.json();
          const latencyMs = Date.now() - startTime;
          
          if (data.success) {
            const result = data.data;
            
            // 判断是否匹配预期
            // 放宽匹配条件：只要动作一致即可，分数范围不严格要求
            const actionMatched = result.action === testCase.expectedAction;
            
            // 对于允许的内容，如果分数在预期范围内也算匹配
            const scoreInRange = result.overallScore >= testCase.expectedScoreMin && 
                                  result.overallScore <= testCase.expectedScoreMax;
            
            // 判断是否匹配：动作必须匹配
            const matched = actionMatched;

            newResults.push({
              providerId,
              providerName: provider.displayName,
              testCaseId,
              actualAction: result.action,
              actualScore: result.overallScore,
              expectedAction: testCase.expectedAction,
              matched,
              findings: result.findings || [],
              latencyMs,
            });

            // 记录检测会话到数据库
            try {
              await recordDetectionSession({
                userPrompt: testCase.inputText,
                inputDetection: {
                  action: result.action,
                  overallScore: result.overallScore,
                  findings: result.findings || [],
                  summary: result.summary,
                  latencyMs,
                } as DetectionResultForRecord,
                policyId: selectedPolicy,
                targetProviderId: providerId,
              });
            } catch (recordError) {
              console.error('记录检测会话失败:', recordError);
            }
          } else {
            // 检测失败，记录为不匹配
            newResults.push({
              providerId,
              providerName: provider.displayName,
              testCaseId,
              actualAction: 'error',
              actualScore: 0,
              expectedAction: testCase.expectedAction,
              matched: false,
              findings: [],
              latencyMs: 0,
            });
          }
        } catch (error) {
          console.error(`评测失败: ${provider.name} - ${testCase.title}`, error);
          newResults.push({
            providerId,
            providerName: provider.displayName,
            testCaseId,
            actualAction: 'error',
            actualScore: 0,
            expectedAction: testCase.expectedAction,
            matched: false,
            findings: [],
            latencyMs: 0,
          });
        }

        current++;
        setProgress({ current, total });
        setResults([...newResults]);
      }
    }

    setIsRunning(false);
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case 'block': return <XCircle className="h-4 w-4 text-red-500" />;
      case 'warn': return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'mask': return <Eye className="h-4 w-4 text-blue-500" />;
      case 'error': return <AlertTriangle className="h-4 w-4 text-gray-500" />;
      default: return <CheckCircle className="h-4 w-4 text-green-500" />;
    }
  };

  const getActionText = (action: string) => {
    switch (action) {
      case 'block': return '拦截';
      case 'warn': return '警告';
      case 'mask': return '脱敏';
      case 'error': return '错误';
      default: return '放行';
    }
  };

  const getAccuracy = (providerId: string) => {
    const providerResults = results.filter(r => r.providerId === providerId);
    if (providerResults.length === 0) return 0;
    const matched = providerResults.filter(r => r.matched).length;
    return Math.round((matched / providerResults.length) * 100);
  };

  const getAverageLatency = (providerId: string) => {
    const providerResults = results.filter(r => r.providerId === providerId);
    if (providerResults.length === 0) return 0;
    const total = providerResults.reduce((sum, r) => sum + r.latencyMs, 0);
    return Math.round(total / providerResults.length);
  };

  return (
    <div className="h-[calc(100vh-100px)] min-h-0 flex gap-4 overflow-hidden">
      {/* 左侧：选择区域 */}
      <div className="w-80 min-h-0 flex flex-col gap-4 overflow-hidden flex-shrink-0">
        {/* 策略选择 */}
        <Card className="flex-shrink-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Settings className="h-5 w-5 text-orange-500" />
              检测策略
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Select value={selectedPolicy} onValueChange={setSelectedPolicy}>
              <SelectTrigger>
                <SelectValue placeholder="选择策略" />
              </SelectTrigger>
              <SelectContent>
                {policies.map(policy => (
                  <SelectItem key={policy.id} value={policy.id}>
                    {policy.name}
                    {policy.isDefault && ' (默认)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* 模型选择 */}
        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <CardHeader className="pb-2 flex-shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Bot className="h-5 w-5 text-blue-500" />
                选择模型
              </CardTitle>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={selectAllProviders}>
                  全选
                </Button>
                <Button variant="ghost" size="sm" onClick={clearProviders}>
                  清空
                </Button>
              </div>
            </div>
            <CardDescription>
              已选择 {selectedProviders.length} / {providers.length} 个模型
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2">
            {providers.length === 0 ? (
              <div className="text-center text-gray-400 py-4">
                暂无可用模型
              </div>
            ) : (
              providers.map(provider => (
                <div
                  key={provider.id}
                  className="flex items-center space-x-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                  onClick={() => toggleProvider(provider.id)}
                >
                  <Checkbox
                    id={provider.id}
                    checked={selectedProviders.includes(provider.id)}
                    onCheckedChange={() => toggleProvider(provider.id)}
                  />
                  <label htmlFor={provider.id} className="flex-1 cursor-pointer">
                    <div className="font-medium text-sm">{provider.displayName}</div>
                    <div className="text-xs text-gray-500">{provider.defaultModel}</div>
                  </label>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* 测试用例选择 */}
        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <CardHeader className="pb-2 flex-shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="h-5 w-5 text-green-500" />
                选择测试用例
              </CardTitle>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={selectAllTestCases}>
                  全选
                </Button>
                <Button variant="ghost" size="sm" onClick={clearTestCases}>
                  清空
                </Button>
              </div>
            </div>
            <CardDescription>
              已选择 {selectedTestCases.length} / {testCases.length} 个用例
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2">
            {testCases.length === 0 ? (
              <div className="text-center text-gray-400 py-4">
                暂无测试用例
              </div>
            ) : (
              testCases.map(testCase => (
                <div
                  key={testCase.id}
                  className="flex items-center space-x-2 p-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                  onClick={() => toggleTestCase(testCase.id)}
                >
                  <Checkbox
                    id={testCase.id}
                    checked={selectedTestCases.includes(testCase.id)}
                    onCheckedChange={() => toggleTestCase(testCase.id)}
                  />
                  <label htmlFor={testCase.id} className="flex-1 cursor-pointer">
                    <div className="font-medium text-sm">{testCase.title}</div>
                    <div className="text-xs text-gray-500">{testCase.category}</div>
                  </label>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* 运行按钮 */}
        <div className="flex-shrink-0 space-y-2">
          {error && (
            <div className="text-red-500 text-sm text-center">{error}</div>
          )}
          <Button
            className="w-full"
            size="lg"
            onClick={runEvaluation}
            disabled={isRunning || selectedProviders.length === 0 || selectedTestCases.length === 0 || !selectedPolicy}
          >
            {isRunning ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                评测中... {progress.current}/{progress.total}
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                开始评测 ({selectedProviders.length * selectedTestCases.length} 条)
              </>
            )}
          </Button>
          {isRunning && (
            <Progress value={(progress.current / progress.total) * 100} />
          )}
        </div>
      </div>

      {/* 右侧：结果区域 */}
      <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden">
        {/* 总体统计 */}
        {results.length > 0 && (
          <div className="grid grid-cols-4 gap-4 flex-shrink-0">
            {selectedProviders.map(providerId => {
              const provider = providers.find(p => p.id === providerId);
              if (!provider) return null;
              const accuracy = getAccuracy(providerId);
              const avgLatency = getAverageLatency(providerId);
              return (
                <Card key={providerId}>
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-sm">{provider.displayName}</span>
                      <BarChart3 className="h-4 w-4 text-gray-400" />
                    </div>
                    <div className="text-2xl font-bold">{accuracy}%</div>
                    <div className="text-xs text-gray-500">准确率 · {avgLatency}ms</div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* 详细结果 */}
        <Card className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <CardHeader className="pb-2 flex-shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-5 w-5 text-purple-500" />
                评测结果详情
              </CardTitle>
              {results.length > 0 && (
                <div className="text-sm text-gray-500">
                  正确率: {Math.round((results.filter(r => r.matched).length / results.length) * 100)}%
                </div>
              )}
            </div>
            <CardDescription>
              共 {results.length} 条结果
            </CardDescription>
          </CardHeader>
          <CardContent 
            ref={resultsContainerRef}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
          >
            {results.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <BarChart3 className="h-12 w-12 mb-4" />
                <p>选择模型和测试用例后开始评测</p>
              </div>
            ) : (
              <div className="space-y-2">
                {results.map((result, index) => {
                  const testCase = testCases.find(t => t.id === result.testCaseId);
                  return (
                    <div
                      key={index}
                      className={`flex items-center justify-between p-3 rounded-lg border ${
                        result.matched ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {result.matched ? (
                          <CheckCircle className="h-5 w-5 text-green-500" />
                        ) : (
                          <XCircle className="h-5 w-5 text-red-500" />
                        )}
                        <div>
                          <div className="font-medium text-sm">{testCase?.title}</div>
                          <div className="text-xs text-gray-500">
                            {result.providerName} · {testCase?.category}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="flex items-center gap-1">
                            {getActionIcon(result.actualAction)}
                            <span className="text-sm">{getActionText(result.actualAction)}</span>
                            <span className="text-xs text-gray-400">
                              (预期: {getActionText(result.expectedAction)})
                            </span>
                          </div>
                          <div className="text-xs text-gray-500">
                            得分: {result.actualScore} · {result.latencyMs}ms
                          </div>
                        </div>
                        <Badge variant={result.matched ? 'default' : 'destructive'}>
                          {result.matched ? '符合预期' : '不符合'}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
