'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Send,
  Loader2,
  User,
  Bot,
  Shield,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  CheckCircle,
  Eye,
  FileText,
  Trash2,
  AlertCircle,
  ChevronRight,
  ChevronLeft
} from 'lucide-react';
import JudgeModelResultCard from '@/components/judge/JudgeModelResultCard';
import { recordDetectionSession, DetectionResultForRecord } from '@/lib/detection/recorder';
import { usePolicyState } from '@/hooks/use-policy-state';
import { csrfHeaders } from '@/lib/auth/csrf-client';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  originalContent?: string; // 脱敏前的原始内容
  timestamp: Date;
  inputDetection?: DetectionResult;
  outputDetection?: DetectionResult;
  blocked?: boolean;
  detectionFailed?: boolean; // 检测服务异常标记
}

interface DetectionResult {
  action: 'allow' | 'block' | 'warn' | 'mask' | 'rewrite';
  overallScore: number;
  confidence: number;
  findings: Array<{
    dimension: string;
    dimensionName: string;
    score: number;
    severity: string;
    matchedRules: string[];
    evidence: string[];
    reason: string;
  }>;
  summary: string;
  safeText?: string;      // 脱敏后的安全文本
  maskedText?: string;    // 脱敏文本（备用）
  rewrittenText?: string; // 安全改写后的文本
  processedText?: string; // 处理后的文本（统一字段，可能是脱敏或改写结果）
  processingActions?: string[]; // 处理动作列表（如：安全改写、自动脱敏）
  // 裁判模型相关字段
  judgeModelResult?: {
    used: boolean;
    score?: number;
    confidence?: number;
    suggestedAction?: 'allow' | 'warn' | 'block';
    reason?: string;
    latencyMs?: number;
    error?: string;
  };
  decisionTrace?: {
    ruleScore: number;
    ruleAction: 'allow' | 'warn' | 'block';
    judgeScore?: number;
    judgeAction?: 'allow' | 'warn' | 'block';
    decisionMode: string;
    finalScore: number;
    finalAction: 'allow' | 'warn' | 'block';
    reasoning: string;
  };
  dimensionResults?: Array<{
    dimensionCode: string;
    dimensionName: string;
    hasRisk: boolean;
    score: number;
    confidence: number;
    reason: string;
  }>;
  ruleReview?: {
    agreeWithRules: boolean;
    falsePositiveSuspected: boolean;
    falseNegativeSuspected: boolean;
    explanation: string;
  };
}

interface Policy {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  isActive: boolean;
}

interface LLMProvider {
  id: string;
  name: string;
  displayName: string;
  defaultModel: string;
}

export default function HomePage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [selectedPolicy, setSelectedPolicy] = useState<string>('');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [currentDetection, setCurrentDetection] = useState<DetectionResult | null>(null);
  const [originalOutputContent, setOriginalOutputContent] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // 策略状态管理
  const { sessionId, isInitialized } = usePolicyState();

  // 只滚动聊天容器，不影响整个页面
  const scrollChatToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = messagesContainerRef.current;
      if (!el) return;
      
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth',
      });
    });
  }, []);

  // 自动滚动：消息变化或加载状态变化时触发
  useEffect(() => {
    if (messages.length > 0 || isLoading) {
      scrollChatToBottom();
    }
  }, [messages, isLoading, scrollChatToBottom]);

  async function loadData() {
    setDataLoading(true);
    setLoadError(null);
    try {
      const [policiesRes, providersRes] = await Promise.all([
        fetch('/api/policies'),
        fetch('/api/chat'),
      ]);

      const policiesData = await policiesRes.json();
      const providersData = await providersRes.json();

      if (policiesData.success) {
        // 只显示启用的策略
        const activePolicies = policiesData.data.filter((p: Policy) => p.isActive);
        setPolicies(activePolicies);
        const defaultPolicy = activePolicies.find((p: Policy) => p.isDefault);
        if (defaultPolicy) {
          setSelectedPolicy(defaultPolicy.id);
        } else if (activePolicies.length > 0) {
          // 如果没有默认策略，选择第一个
          setSelectedPolicy(activePolicies[0].id);
        }
      }

      if (providersData.success) {
        setProviders(providersData.data);
        if (providersData.data.length > 0) {
          setSelectedProvider(providersData.data[0].id);
        }
      }
    } catch (error) {
      console.error('加载数据失败:', error);
      setLoadError('加载配置数据失败，请刷新页面重试');
    } finally {
      setDataLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  // 输入检测 - fail-closed 策略
  const detectInput = async (text: string): Promise<DetectionResult> => {
    try {
      if (!selectedPolicy) {
        return {
          action: 'block',
          overallScore: 100,
          confidence: 1,
          findings: [],
          summary: '未选择检测策略，已按安全策略阻断请求。',
        };
      }

      const response = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          text,
          direction: 'input',
          policyId: selectedPolicy,
          sessionId: isInitialized ? sessionId : undefined,
          userId: 'anonymous',
        }),
      });

      const data = await response.json();
      if (data.success && data.data) {
        return data.data;
      }

      // 接口返回失败 - fail-closed
      return {
        action: 'block',
        overallScore: 100,
        confidence: 1,
        findings: [],
        summary: '安全检测服务异常，已按安全策略阻断请求。',
      };
    } catch (error) {
      console.error('输入检测失败:', error);
      // 异常情况 - fail-closed
      return {
        action: 'block',
        overallScore: 100,
        confidence: 1,
        findings: [],
        summary: '安全检测服务异常，已按安全策略阻断请求。',
      };
    }
  };

  // 输出检测 - fail-closed 策略
  const detectOutput = async (text: string): Promise<DetectionResult> => {
    try {
      if (!selectedPolicy) {
        return {
          action: 'block',
          overallScore: 100,
          confidence: 1,
          findings: [],
          summary: '未选择检测策略，已按安全策略阻断输出。',
        };
      }

      const response = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          text,
          direction: 'output',
          policyId: selectedPolicy,
          sessionId: isInitialized ? sessionId : undefined,
          userId: 'anonymous',
        }),
      });

      const data = await response.json();
      if (data.success && data.data) {
        return data.data;
      }

      // 接口返回失败 - fail-closed
      return {
        action: 'block',
        overallScore: 100,
        confidence: 1,
        findings: [],
        summary: '安全检测服务异常，已按安全策略阻断输出。',
      };
    } catch (error) {
      console.error('输出检测失败:', error);
      // 异常情况 - fail-closed
      return {
        action: 'block',
        overallScore: 100,
        confidence: 1,
        findings: [],
        summary: '安全检测服务异常，已按安全策略阻断输出。',
      };
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    
    // 校验策略和模型是否已选择
    if (!selectedPolicy || !selectedProvider) {
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setInput('');
    setIsLoading(true);

    // 检测输入 - fail-closed
    const inputDetection = await detectInput(userMessage.content);
    userMessage.inputDetection = inputDetection;
    setCurrentDetection(inputDetection);

    // 如果检测失败或输入被拦截，不发送给模型
    if (!inputDetection || inputDetection.action === 'block') {
      userMessage.blocked = true;
      if (!inputDetection) {
        userMessage.detectionFailed = true;
        userMessage.content = '⚠️ 安全检测服务异常，请求已被阻断。';
      }
      setMessages(prev => [...prev, userMessage]);
      setIsLoading(false);

      // 策略升级汇总：输入被拦截也有风险
      if (isInitialized && sessionId) {
        try {
          const inputHasRisk = inputDetection?.findings && inputDetection.findings.length > 0 && inputDetection.overallScore > 0;

          await fetch('/api/escalation-summary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
            body: JSON.stringify({
              userId: 'anonymous',
              sessionId,
              policyId: selectedPolicy,
              inputHasRisk: inputHasRisk || false,
              outputHasRisk: false, // 输入被拦截，没有输出
            }),
          });
        } catch (escalationError) {
          console.error('策略升级汇总失败:', escalationError);
        }
      }

      // 记录被拦截的检测会话
      try {
        await recordDetectionSession({
          userPrompt: userMessage.content,
          mockModelOutput: undefined,
          finalResponse: undefined,
          inputDetection: inputDetection as DetectionResultForRecord,
          outputDetection: undefined,
          policyId: selectedPolicy,
          targetProviderId: selectedProvider,
        });
      } catch (recordError) {
        console.error('记录检测会话失败:', recordError);
      }
      return;
    }

    // 如果输入需要脱敏或改写，使用处理后的文本
    let safeUserContent = userMessage.content;
    
    // 检查是否有处理后的文本（可能是 mask、rewrite 或 warn 时附带的处理）
    if (inputDetection.processedText && inputDetection.processedText !== userMessage.content) {
      // 有处理后的文本，使用处理后的版本
      if (inputDetection.rewrittenText) {
        safeUserContent = inputDetection.rewrittenText;
      } else if (inputDetection.safeText) {
        safeUserContent = inputDetection.safeText;
      } else if (inputDetection.maskedText) {
        safeUserContent = inputDetection.maskedText;
      } else {
        safeUserContent = inputDetection.processedText;
      }
    } else if (inputDetection.action === 'mask') {
      // 脱敏处理
      if (inputDetection.safeText) {
        safeUserContent = inputDetection.safeText;
      } else if (inputDetection.maskedText) {
        safeUserContent = inputDetection.maskedText;
      } else if (inputDetection.processedText) {
        safeUserContent = inputDetection.processedText;
      }
    } else if (inputDetection.action === 'rewrite') {
      // 改写处理
      if (inputDetection.rewrittenText) {
        safeUserContent = inputDetection.rewrittenText;
      } else if (inputDetection.processedText) {
        safeUserContent = inputDetection.processedText;
      }
    }
    
    // 如果内容被处理，显示处理后的安全内容，原始内容保存到 originalContent 供查看
    if (safeUserContent !== userMessage.content) {
      userMessage.originalContent = userMessage.content;  // 保存原始内容
      userMessage.content = safeUserContent;  // 显示安全处理后的内容
    }

    // 构建历史消息（使用安全内容）
    const chatMessages = messages
      .filter(m => !m.blocked)
      .map(m => ({
        role: m.role,
        content: m.role === 'user' 
          ? m.inputDetection?.rewrittenText || m.inputDetection?.safeText || m.inputDetection?.maskedText || m.inputDetection?.processedText || m.content
          : m.outputDetection?.rewrittenText || m.outputDetection?.safeText || m.outputDetection?.maskedText || m.outputDetection?.processedText || m.content,
      }));
    chatMessages.push({ role: 'user', content: safeUserContent });

    setMessages(prev => [...prev, userMessage]);

    try {
      // 调用 LLM API
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({
          providerId: selectedProvider,
          messages: chatMessages,
        }),
      });

      const data = await response.json();

      if (data.success) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.data.response,
          timestamp: new Date(),
        };

        // 检测输出 - fail-closed
        const outputDetection = await detectOutput(assistantMessage.content);
        assistantMessage.outputDetection = outputDetection;
        setCurrentDetection(outputDetection);

        // 根据输出检测结果处理内容
        if (!outputDetection) {
          // 检测服务异常
          assistantMessage.blocked = true;
          assistantMessage.detectionFailed = true;
          assistantMessage.content = '⚠️ 安全检测服务异常，模型输出已被阻断。';
          setOriginalOutputContent(assistantMessage.content);
        } else if (outputDetection.action === 'block') {
          // 阻止输出
          assistantMessage.blocked = true;
          assistantMessage.originalContent = assistantMessage.content;
          setOriginalOutputContent(assistantMessage.content);
          assistantMessage.content = '🚫 模型输出存在安全风险，已被护栏拦截。';
        } else if (outputDetection.action === 'mask') {
          // 脱敏输出
          assistantMessage.originalContent = assistantMessage.content;
          setOriginalOutputContent(assistantMessage.content);
          if (outputDetection.safeText || outputDetection.maskedText) {
            assistantMessage.content = outputDetection.safeText || outputDetection.maskedText!;
          } else {
            // 如果没有返回脱敏文本，显示提示
            assistantMessage.content = '🔒 模型输出包含敏感信息，已脱敏处理。';
          }
        } else if (outputDetection.action === 'warn') {
          // 警告但仍显示，可以添加警告标记
          // 内容保持不变，但可以添加视觉提示
          setOriginalOutputContent(null);
        } else {
          // allow 动作保持原样
          setOriginalOutputContent(null);
        }

        // 策略升级汇总：输入或输出有风险就加1次
        let escalationMessage: string | null = null;
        let policyEscalated = false;
        let policyDeescalated = false;
        if (isInitialized && sessionId) {
          try {
            const inputHasRisk = inputDetection?.findings && inputDetection.findings.length > 0 && inputDetection.overallScore > 0;
            const outputHasRisk = outputDetection?.findings && outputDetection.findings.length > 0 && outputDetection.overallScore > 0;

            const escalationResponse = await fetch('/api/escalation-summary', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
              body: JSON.stringify({
                userId: 'anonymous',
                sessionId,
                policyId: selectedPolicy,
                inputHasRisk: inputHasRisk || false,
                outputHasRisk: outputHasRisk || false,
              }),
            });

            const escalationData = await escalationResponse.json();
            if (escalationData.success && escalationData.data) {
              escalationMessage = escalationData.data.message;
              policyEscalated = escalationData.data.shouldEscalate;
              policyDeescalated = escalationData.data.shouldDeescalate;
            }
          } catch (escalationError) {
            console.error('策略升级汇总失败:', escalationError);
          }
        }

        // 如果策略升级或降级了，显示提示消息
        if ((policyEscalated || policyDeescalated) && escalationMessage) {
          const escalationNotify: Message = {
            id: (Date.now() + 2).toString(),
            role: 'assistant',
            content: `${policyEscalated ? '⚠️' : '✅'} ${escalationMessage}`,
            timestamp: new Date(),
          };
          setMessages(prev => [...prev, assistantMessage, escalationNotify]);
        } else {
          setMessages(prev => [...prev, assistantMessage]);
        }

        // 记录检测会话到数据库
        try {
          await recordDetectionSession({
            userPrompt: userMessage.content,
            mockModelOutput: assistantMessage.originalContent || assistantMessage.content,
            finalResponse: assistantMessage.content,
            inputDetection: inputDetection as DetectionResultForRecord,
            outputDetection: outputDetection as DetectionResultForRecord,
            policyId: selectedPolicy,
            targetProviderId: selectedProvider,
          });
        } catch (recordError) {
          console.error('记录检测会话失败:', recordError);
          // 记录失败不影响主流程
        }
      } else {
        const errorMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `❌ 错误: ${data.error || '模型调用失败'}`,
          timestamp: new Date(),
          blocked: true,
        };
        setMessages(prev => [...prev, errorMessage]);
      }
    } catch (error) {
      console.error('发送消息失败:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '❌ 发送消息失败，请重试。',
        timestamp: new Date(),
        blocked: true,
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const clearMessages = () => {
    setMessages([]);
    setCurrentDetection(null);
    setOriginalOutputContent(null);
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case 'block':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'warn':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'mask':
        return <Eye className="h-4 w-4 text-blue-500" />;
      default:
        return <CheckCircle className="h-4 w-4 text-green-500" />;
    }
  };

  const getActionColor = (action: string) => {
    switch (action) {
      case 'block':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'warn':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'mask':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      default:
        return 'bg-green-100 text-green-800 border-green-200';
    }
  };

  const getActionText = (action: string) => {
    switch (action) {
      case 'block':
        return '已拦截';
      case 'warn':
        return '已警告';
      case 'mask':
        return '已脱敏';
      default:
        return '已放行';
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return 'bg-red-500';
    if (score >= 40) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  return (
    <div className="h-[calc(100vh-64px-48px)] min-h-0 flex gap-4 overflow-hidden relative">
      {/* 左侧：聊天对话界面 */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
        {/* 配置区域 */}
        <Card className="mb-4 flex-shrink-0">
          <CardContent className="py-3">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-gray-500" />
                <span className="text-sm text-gray-500">策略:</span>
                <Select value={selectedPolicy} onValueChange={setSelectedPolicy}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="选择策略" />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    {policies.map(p => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {p.isDefault && ' (默认)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!selectedPolicy && !dataLoading && (
                  <span className="text-red-500 text-xs">请选择策略</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-gray-500" />
                <span className="text-sm text-gray-500">模型:</span>
                <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    {providers.map(p => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.displayName} ({p.defaultModel})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!selectedProvider && !dataLoading && (
                  <span className="text-red-500 text-xs">请选择模型</span>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={clearMessages} className="ml-auto">
                <Trash2 className="h-4 w-4 mr-1" />
                清空对话
              </Button>
            </div>
            {loadError && (
              <div className="flex items-center gap-2 mt-2 text-red-500 text-sm">
                <AlertCircle className="h-4 w-4" />
                {loadError}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 消息列表 */}
        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <CardContent
            ref={messagesContainerRef}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-4"
          >
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <Bot className="h-12 w-12 mb-4" />
                <p>开始对话</p>
                <p className="text-sm mt-2">安全对话模式，输入输出双向检测 · 关键词引擎 + 裁判模型双引擎守护</p>
              </div>
            ) : (
              messages.map(message => (
                <div
                  key={message.id}
                  className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {message.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                      <Bot className="h-4 w-4 text-blue-600" />
                    </div>
                  )}
                  <div className={`max-w-[70%] ${message.blocked ? 'opacity-60' : ''}`}>
                    {message.role === 'user' && message.blocked && (
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className="bg-red-100 text-red-800 text-xs">
                          <XCircle className="h-3 w-3 mr-1" />
                          {message.detectionFailed ? '检测异常-已阻断' : '输入被拦截'}
                        </Badge>
                      </div>
                    )}
                    {message.role === 'user' && message.inputDetection?.action === 'mask' && (
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className="bg-blue-100 text-blue-800 text-xs">
                          <Eye className="h-3 w-3 mr-1" />
                          输入已脱敏
                        </Badge>
                      </div>
                    )}
                    {message.role === 'user' && message.inputDetection?.action === 'rewrite' && (
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className="bg-purple-100 text-purple-800 text-xs">
                          <ShieldCheck className="h-3 w-3 mr-1" />
                          输入已安全改写
                        </Badge>
                      </div>
                    )}
                    {message.role === 'assistant' && message.blocked && (
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className="bg-red-100 text-red-800 text-xs">
                          <XCircle className="h-3 w-3 mr-1" />
                          {message.detectionFailed ? '检测异常-已阻断' : '输出被拦截'}
                        </Badge>
                      </div>
                    )}
                    {message.role === 'assistant' && message.outputDetection?.action === 'warn' && (
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className="bg-yellow-100 text-yellow-800 text-xs">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          输出警告
                        </Badge>
                      </div>
                    )}
                    {message.role === 'assistant' && message.outputDetection?.action === 'mask' && (
                      <div className="flex items-center gap-2 mb-1">
                        <Badge className="bg-blue-100 text-blue-800 text-xs">
                          <Eye className="h-3 w-3 mr-1" />
                          输出已脱敏
                        </Badge>
                      </div>
                    )}
                    <div
                      className={`rounded-lg px-4 py-2 ${
                        message.role === 'user'
                          ? message.blocked
                            ? 'bg-red-50 text-gray-700 border border-red-200'
                            : 'bg-blue-500 text-white'
                          : message.blocked
                            ? 'bg-red-50 text-gray-700 border border-red-200'
                            : 'bg-gray-100 text-gray-900'
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                      {/* 显示被改写/脱敏的原文 */}
                      {message.originalContent && (
                        <details className="mt-2 pt-2 border-t border-blue-300">
                          <summary className="text-xs text-blue-200 cursor-pointer hover:text-white">
                            📄 查看原始{message.role === 'user' ? '输入' : '输出'}
                          </summary>
                          <div className="mt-2 p-2 bg-blue-400/50 rounded text-xs text-blue-100 whitespace-pre-wrap max-h-40 overflow-auto">
                            {message.originalContent}
                          </div>
                        </details>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      {message.timestamp.toLocaleTimeString()}
                    </div>
                  </div>
                  {message.role === 'user' && (
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                      <User className="h-4 w-4 text-gray-600" />
                    </div>
                  )}
                </div>
              ))
            )}
            {isLoading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                  <Bot className="h-4 w-4 text-blue-600" />
                </div>
                <div className="bg-gray-100 rounded-lg px-4 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                </div>
              </div>
            )}
          </CardContent>

          {/* 输入框 */}
          <div className="border-t p-4 flex-shrink-0">
            <div className="flex gap-2">
              <Textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={
                  dataLoading 
                    ? "加载配置中..." 
                    : !selectedPolicy || !selectedProvider
                      ? "请先选择策略和模型"
                      : "输入消息... (Shift+Enter 换行，Enter 发送)"
                }
                className="flex-1 min-h-[60px] max-h-[120px] resize-none"
                disabled={dataLoading || !selectedPolicy || !selectedProvider}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />
              <Button 
                onClick={sendMessage} 
                disabled={!input.trim() || isLoading || dataLoading || !selectedPolicy || !selectedProvider}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* 右侧：检测结果面板 */}
      {/* 切换按钮 - 小屏幕时显示 */}
      <button
        onClick={() => setShowRightPanel(!showRightPanel)}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-50 bg-primary text-primary-foreground p-2 rounded-l-lg shadow-lg lg:hidden"
        aria-label={showRightPanel ? '收起检测结果' : '展开检测结果'}
        aria-expanded={showRightPanel}
      >
        {showRightPanel ? <ChevronRight className="h-5 w-5" /> : <ChevronLeft className="h-5 w-5" />}
      </button>

      {/* 右侧面板 */}
      <div className={`
        w-[min(24rem,100vw)] min-h-0 flex flex-col gap-4 flex-shrink-0
        fixed lg:relative right-0 top-16 h-[calc(100%-4rem)] lg:top-auto lg:h-auto z-40
        bg-background border-l lg:border-0 p-4 lg:p-0
        transition-transform duration-300
        ${showRightPanel ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}
      `}>
        <Card className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <CardHeader className="pb-2 flex-shrink-0">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-blue-500" />
              实时检测结果
            </CardTitle>
            <CardDescription>
              输入/输出护栏实时监控 (Fail-Closed)
            </CardDescription>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-4">
            {!currentDetection ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <Shield className="h-12 w-12 mb-4" />
                <p>等待输入...</p>
                <p className="text-sm mt-2">发送消息后显示检测结果</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* 总体状态 */}
                <div className={`rounded-lg p-4 border ${getActionColor(currentDetection.action)}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      {getActionIcon(currentDetection.action)}
                      <span className="font-semibold">{getActionText(currentDetection.action)}</span>
                    </div>
                    <Badge variant="outline">
                      置信度 {(currentDetection.confidence * 100).toFixed(0)}%
                    </Badge>
                  </div>
                  
                  {/* 分数条 */}
                  <div className="mb-2">
                    <div className="flex justify-between text-sm mb-1">
                      <span>风险分数</span>
                      <span className="font-semibold">{currentDetection.overallScore}</span>
                    </div>
                    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${getScoreColor(currentDetection.overallScore)} transition-all`}
                        style={{ width: `${Math.min(currentDetection.overallScore, 100)}%` }}
                      />
                    </div>
                  </div>

                  <p className="text-sm">{currentDetection.summary}</p>
                  
                  {/* 显示脱敏信息 */}
                  {currentDetection.action === 'mask' && (currentDetection.safeText || currentDetection.maskedText) && (
                    <div className="mt-2 p-2 bg-white/50 rounded text-xs">
                      <span className="font-medium">脱敏后文本: </span>
                      {currentDetection.safeText || currentDetection.maskedText}
                    </div>
                  )}

                  {/* 显示原始输出内容（被拦截或脱敏时） */}
                  {originalOutputContent && (currentDetection.action === 'block' || currentDetection.action === 'mask') && (
                    <details className="mt-3">
                      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700 flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        查看模型原始输出
                      </summary>
                      <div className="mt-2 p-2 bg-gray-100 rounded text-xs text-gray-600 whitespace-pre-wrap max-h-32 overflow-auto border">
                        {originalOutputContent}
                      </div>
                    </details>
                  )}
                </div>

                {/* 检测详情 */}
                {currentDetection.findings.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="font-medium text-sm text-gray-700">风险维度详情</h4>
                    {currentDetection.findings.map((finding, idx) => (
                      <div key={idx} className="bg-gray-50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium text-sm">{finding.dimensionName}</span>
                          <Badge className={getActionColor(finding.severity === 'high' ? 'block' : finding.severity === 'medium' ? 'warn' : 'allow')}>
                            {finding.score} 分
                          </Badge>
                        </div>
                        
                        {/* 分数条 */}
                        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden mb-2">
                          <div
                            className={`h-full ${getScoreColor(finding.score)} transition-all`}
                            style={{ width: `${Math.min(finding.score, 100)}%` }}
                          />
                        </div>

                        {/* 命中规则 */}
                        {finding.matchedRules.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-2">
                            {finding.matchedRules.map((rule, i) => (
                              <Badge key={i} variant="outline" className="text-xs">
                                {rule}
                              </Badge>
                            ))}
                          </div>
                        )}

                        {/* 证据 */}
                        {finding.evidence.length > 0 && (
                          <div className="text-xs text-gray-600 bg-white rounded p-2">
                            <span className="font-medium">证据: </span>
                            {finding.evidence.join(', ')}
                          </div>
                        )}

                        {/* 原因 */}
                        {finding.reason && (
                          <p className="text-xs text-gray-500 mt-1">{finding.reason}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* 无风险提示 */}
                {currentDetection.findings.length === 0 && currentDetection.action === 'allow' && (
                  <div className="flex items-center gap-2 text-green-600 bg-green-50 rounded-lg p-3">
                    <ShieldCheck className="h-5 w-5" />
                    <span className="text-sm">未检测到安全风险</span>
                  </div>
                )}

                {/* 裁判模型结果 */}
                {currentDetection.judgeModelResult && (
                  <JudgeModelResultCard
                    judgeModelResult={currentDetection.judgeModelResult}
                    decisionTrace={currentDetection.decisionTrace}
                    dimensionResults={currentDetection.dimensionResults}
                    ruleReview={currentDetection.ruleReview}
                    displayMode="compact"
                    defaultExpanded={false}
                  />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
