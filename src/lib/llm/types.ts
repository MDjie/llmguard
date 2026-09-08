/**
 * 检测器兼容类型定义
 *
 * 原 LLM Gateway 栈（gateway.ts、orchestrator.ts、judge-llm.ts 与
 * OpenAI 兼容适配器）已移除：生产调用链路统一为 src/lib/providers。
 * detectors/ 下的检测器作为 guard-engine-v2 目录的兼容适配器保留，
 * 并继续共享以下类型。
 */

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

// ==================== 检测器接口 ====================

export interface IRiskDetector {
  readonly dimension: RiskDimension;
  detect(text: string): Promise<RiskFinding>;
}
