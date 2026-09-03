/**
 * 检测引擎类型定义
 */

// 类型定义
export interface DetectionDimension {
  id: string;
  code: string;
  name: string;
  description?: string;
  category?: string;
  weight: number;
  priority: number;
  enabled: boolean;
  isSystem: boolean;
  config: Record<string, unknown>;
}

export interface DetectionRule {
  id: string;
  dimensionId: string;
  groupId?: string;
  name: string;
  type: 'keyword' | 'regex' | 'semantic' | 'llm';
  pattern?: string;
  matchType: 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex';
  caseSensitive: boolean;
  score: number;
  confidence: number;
  priority: number;
  enabled: boolean;
  description?: string;
  config: Record<string, unknown>;
  suggestion?: string;
}

export interface RuleGroup {
  id: string;
  dimensionId: string;
  name: string;
  description?: string;
  logic: 'OR' | 'AND';
  score: number;
  priority: number;
  enabled: boolean;
}

export interface PolicyDimensionConfigItem {
  id: string;
  policyId: string;
  dimensionId: string;
  enabled: boolean;
  warnEnabled: boolean;    // 是否启用警告
  blockEnabled: boolean;   // 是否启用阻断
  warnThreshold: number;
  blockThreshold: number;
  autoMask: boolean;
  autoRewrite: boolean;
  customWeight?: number;
  actionConfig: Record<string, unknown>;
}

// 新版白名单规则类型
export interface WhitelistRule {
  id: string;
  name?: string;
  description?: string;
  // 策略范围
  policyScope: 'all' | 'specific';  // 'all'=全部策略, 'specific'=指定策略
  policyIds?: string[];  // 当 policyScope = 'specific' 时，关联的策略ID列表
  // 维度范围
  dimensionScope: 'all' | 'specific';  // 'all'=全部维度, 'specific'=指定维度
  dimensionCodes: string[];  // 当 dimensionScope = 'specific' 时，适用的维度编码列表
  // 优先级
  priority: number;
  // 匹配规则
  pattern: string;
  matchType: 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex';
  caseSensitive: boolean;
  enabled: boolean;
  // 兼容旧字段
  policyId?: string;
  dimensionId?: string;
}

// 白名单命中信息
export interface WhitelistMatched {
  id: string;
  name: string;
  policyScope: 'all' | 'specific';
  dimensionScope: 'all' | 'specific';
  dimensionCodes: string[];
  pattern: string;
  matchType: string;
  effect: 'skip_all_detection' | 'skip_selected_dimensions';
}

// 被跳过的维度信息
export interface SkippedDimension {
  dimensionCode: string;
  dimensionName: string;
  whitelistId: string;
  whitelistName: string;
  effect: 'skip_dimension_detection';
}

export interface CachedPolicyConfig {
  policyId: string;
  version: number;
  dimensions: DetectionDimension[];
  rules: Map<string, DetectionRule[]>;
  ruleGroups: Map<string, RuleGroup[]>;
  whitelists: WhitelistRule[];
  dimensionConfigs: PolicyDimensionConfigItem[];
  cachedAt: number;
}

export interface DetectionFinding {
  dimension: string;
  dimensionName: string;
  dimensionId?: string;
  dimensionCode?: string;
  score: number;
  action: string;
  matchedRules: string[];
  evidence: string[];
  maskedEvidence?: string[];
  reason: string;
  suggestion?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  confidence?: number;
  ruleId?: string;
  ruleName?: string;
  ruleType?: 'keyword' | 'regex' | 'semantic' | 'llm';
  startOffset?: number;
  endOffset?: number;
  whitelistMatched?: WhitelistMatched;
  skippedDimensions?: SkippedDimension[];
}

export interface DetectionResult {
  overallScore: number;
  confidence: number;
  action: 'allow' | 'warn' | 'block' | 'mask' | 'rewrite';
  findings: DetectionFinding[];
  maskedText?: string;
  rewrittenText?: string;
  summary?: string;
  latencyMs?: number;
  policyVersion?: number;
  degradationReasons?: string[];
  // 白名单命中信息
  whitelistMatched?: WhitelistMatched;
  skippedDimensions?: SkippedDimension[];
  // 裁判模型相关
  judgeModelResult?: {
    used: boolean;
    score?: number;
    confidence?: number;
    suggestedAction?: 'allow' | 'warn' | 'block';
    reason?: string;
    latencyMs?: number;
    error?: string;
    parseError?: string;
    fallbackUsed?: boolean;
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
}
