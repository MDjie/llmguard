/**
 * LLM Gateway 类型定义
 * 支持多种大模型 API 接入
 */

// ==================== Provider 类型 ====================

export type ProviderType = 
  | 'openai_compatible'  // OpenAI 兼容 API
  | 'deepseek'           // DeepSeek
  | 'kimi'               // Kimi
  | 'doubao'             // 豆包
  | 'qwen'               // 通义千问
  | 'glm'                // 智谱 GLM
  | 'ollama'             // 本地模型
  | 'custom';            // 自定义 OpenAI 兼容端点

export type ProviderUseCase = 'target' | 'judge' | 'both';

export interface LLMProvider {
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  isEnabled: boolean;
  useCase: ProviderUseCase;
  createdAt: Date;
  updatedAt: Date;
}

// ==================== 请求/响应类型 ====================

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatRequest {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface LLMChatResponse {
  id: string;
  content: string;
  model: string;
  provider: string;
  providerType: ProviderType;
  latencyMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  raw?: unknown;
}

export interface LLMTestConnectionResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}

// ==================== 检测相关类型 ====================

export type RiskDimension = 
  | 'prompt_injection'   // 提示词注入
  | 'pii_leak'           // PII 泄露
  | 'malicious_code'     // 恶意代码
  | 'violence_hate'      // 暴力仇恨
  | 'illegal_content';   // 非法内容

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type DetectionAction = 'block' | 'warn' | 'allow' | 'mask' | 'rewrite';

export type DetectionDirection = 'input' | 'output';

export interface RiskFinding {
  dimension: RiskDimension;
  score: number;           // 0-100
  confidence: number;      // 0-1
  severity: Severity;
  matchedRules: string[];
  evidence: string[];
  reason: string;
  suggestion?: string;
}

export interface DetectionResult {
  text: string;
  direction: DetectionDirection;
  overallScore: number;    // 0-100
  confidence: number;      // 0-1
  action: DetectionAction;
  findings: RiskFinding[];
  summary: string;
  latencyMs: number;
  maskedText?: string;      // PII脱敏后的文本
  rewrittenText?: string;   // 安全改写后的文本
}

export interface DetectionSession {
  id: string;
  userPrompt: string;
  mockModelOutput?: string;
  finalResponse?: string;
  
  inputAction?: DetectionAction;
  inputScore?: number;
  inputSummary?: string;
  
  outputAction?: DetectionAction;
  outputScore?: number;
  outputSummary?: string;
  
  finalAction: DetectionAction;
  policyId: string;
  
  createdAt: Date;
  durationMs: number;
}

// ==================== 策略相关类型 ====================

export interface PolicyRule {
  dimension: RiskDimension;
  enabled: boolean;
  warnThreshold: number;   // 0-100
  blockThreshold: number;  // 0-100
  autoMask: boolean;
  autoRewrite: boolean;
}

export interface KeywordRule {
  dimension: RiskDimension;
  keyword: string;
  score: number;           // 0-100
  enabled: boolean;
  description?: string;
}

export interface PolicyProfile {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  rules: PolicyRule[];
  keywords: KeywordRule[];
  createdAt: Date;
  updatedAt: Date;
}

// ==================== 测试用例类型 ====================

export type TestCaseCategory = 
  | 'normal_qa'           // 正常问答
  | 'prompt_injection'    // 提示词注入
  | 'pii_leak'           // PII 泄露
  | 'malicious_code'      // 恶意代码
  | 'violence_hate'       // 暴力仇恨
  | 'illegal_content'     // 非法内容
  | 'output_leak';        // 输出泄露

export interface TestCase {
  id: string;
  title: string;
  description?: string;
  category: TestCaseCategory;
  inputText: string;
  outputText?: string;
  expectedAction: DetectionAction;
  expectedDimensions: RiskDimension[];
  expectedScoreMin?: number;
  expectedScoreMax?: number;
  severity: Severity;
  enabled: boolean;
  createdAt: Date;
}

// ==================== Provider Adapter 接口 ====================

export interface IProviderAdapter {
  readonly name: string;
  readonly providerType: ProviderType;
  
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
  testConnection(): Promise<LLMTestConnectionResult>;
}

// ==================== 检测器接口 ====================

export interface IRiskDetector {
  readonly dimension: RiskDimension;
  detect(text: string): Promise<RiskFinding>;
}

// ==================== 配置类型 ====================

export interface LLMGatewayConfig {
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  defaultTemperature: number;
  defaultMaxTokens: number;
}

export const DEFAULT_GATEWAY_CONFIG: LLMGatewayConfig = {
  maxRetries: 1,
  retryDelayMs: 1000,
  timeoutMs: 30000,
  defaultTemperature: 0.3,
  defaultMaxTokens: 2048,
};
