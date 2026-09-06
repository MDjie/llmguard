/**
 * 检测编排引擎
 * 
 * 功能：
 * 1. 组合所有风险检测器
 * 2. 执行并行检测
 * 3. 融合评分
 * 4. 根据策略决定动作
 */

import type {
  DetectionResult,
  DetectionAction,
  DetectionDirection,
  RiskFinding,
  PolicyProfile,
  PolicyRule,
  KeywordRule,
} from './types';
import { PromptInjectionDetector } from './detectors/prompt-injection';
import { PIILeakDetector } from './detectors/pii-leak';
import { dimensionLabel } from '@/lib/dimension-labels';
import { MaliciousCodeDetector } from './detectors/malicious-code';
import { ViolenceHateDetector } from './detectors/violence-hate';
import { IllegalContentDetector } from './detectors/illegal-content';
import type { IRiskDetector } from './types';

export class DetectionOrchestrator {
  private detectors: Map<string, IRiskDetector> = new Map();

  constructor() {
    // 注册所有检测器
    this.detectors.set('prompt_injection', new PromptInjectionDetector());
    this.detectors.set('pii_leak', new PIILeakDetector());
    this.detectors.set('malicious_code', new MaliciousCodeDetector());
    this.detectors.set('violence_hate', new ViolenceHateDetector());
    this.detectors.set('illegal_content', new IllegalContentDetector());
  }

  /**
   * 执行检测
   */
  async detect(
    text: string,
    direction: DetectionDirection,
    policy: PolicyProfile
  ): Promise<DetectionResult> {
    const startTime = Date.now();

    // 1. 执行所有检测器（并行）
    const findings = await this.runAllDetectors(text);

    // 2. 应用自定义关键词规则
    const keywordFindings = this.applyKeywordRules(text, policy.keywords);
    findings.push(...keywordFindings);

    // 3. 融合评分
    const overallScore = this.calculateOverallScore(findings);
    const confidence = this.calculateConfidence(findings);

    // 4. 根据策略决定动作
    const action = this.decideAction(overallScore, findings, policy.rules);

    // 5. 如果需要脱敏，调用PII脱敏器
    let maskedText: string | undefined;
    if (action === 'mask') {
      const { maskPII } = await import('@/lib/guardrail/pii-masker');
      const maskResult = maskPII(text);
      maskedText = maskResult.maskedText;
    }

    // 6. 如果需要改写，调用改写引擎
    let rewrittenText: string | undefined;
    if (action === 'rewrite' && findings[0]?.dimension) {
      const { rewriteContent } = await import('@/lib/guardrail/rewrite-engine');
      const rewriteResult = rewriteContent(text, [findings[0].dimension]);
      rewrittenText = rewriteResult.rewrittenText;
    }

    // 7. 生成摘要
    const summary = this.generateSummary(findings, action);

    const latencyMs = Date.now() - startTime;

    return {
      text,
      direction,
      overallScore,
      confidence,
      action,
      findings,
      summary,
      latencyMs,
      maskedText,
      rewrittenText,
    };
  }

  /**
   * 执行所有检测器（并行）
   */
  private async runAllDetectors(text: string): Promise<RiskFinding[]> {
    const promises: Promise<RiskFinding>[] = [];

    for (const [dimension, detector] of this.detectors) {
      promises.push(detector.detect(text));
    }

    return Promise.all(promises);
  }

  /**
   * 应用自定义关键词规则
   */
  private applyKeywordRules(text: string, keywords?: KeywordRule[]): RiskFinding[] {
    const findings: RiskFinding[] = [];
    const findingsByDimension = new Map<string, RiskFinding>();

    // 添加空值检查
    if (!keywords || !Array.isArray(keywords)) {
      return findings;
    }

    for (const rule of keywords) {
      if (!rule.enabled) continue;

      if (text.toLowerCase().includes(rule.keyword.toLowerCase())) {
        // 获取或创建该维度的 Finding
        let finding = findingsByDimension.get(rule.dimension);
        
        if (!finding) {
          finding = {
            dimension: rule.dimension,
            score: 0,
            confidence: 0.8,
            severity: 'medium',
            matchedRules: [],
            evidence: [],
            reason: `检测到自定义关键词命中`,
            suggestion: '建议进一步审查',
          };
          findingsByDimension.set(rule.dimension, finding);
        }

        // 更新 Finding
        finding.score = Math.max(finding.score, rule.score);
        finding.matchedRules.push(`keyword:${rule.keyword}`);
        finding.evidence.push(rule.keyword);
      }
    }

    // 更新严重程度
    for (const finding of findingsByDimension.values()) {
      finding.severity = this.getSeverity(finding.score);
    }

    return Array.from(findingsByDimension.values());
  }

  /**
   * 计算总体风险分数
   */
  private calculateOverallScore(findings: RiskFinding[]): number {
    if (findings.length === 0) {
      return 0;
    }

    // 取所有维度中的最高分
    const maxScore = Math.max(...findings.map(f => f.score));

    // 根据维度数量加权
    const highRiskCount = findings.filter(f => f.score >= 70).length;
    const weightBonus = Math.min(highRiskCount * 5, 15);

    return Math.min(maxScore + weightBonus, 100);
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(findings: RiskFinding[]): number {
    if (findings.length === 0) {
      return 0.5;
    }

    // 计算平均置信度
    const avgConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;

    // 根据高风险维度数量调整
    const highRiskCount = findings.filter(f => f.score >= 70).length;
    const confidenceBoost = highRiskCount > 1 ? 0.05 : 0;

    return Math.min(avgConfidence + confidenceBoost, 1);
  }

  /**
   * 根据策略决定动作
   */
  private decideAction(
    overallScore: number,
    findings: RiskFinding[],
    rules: PolicyRule[]
  ): DetectionAction {
    // 检查是否有任何维度达到拦截阈值
    for (const finding of findings) {
      const rule = rules.find(r => r.dimension === finding.dimension);
      
      if (rule && rule.enabled) {
        if (finding.score >= rule.blockThreshold) {
          return 'block';
        }
      }
    }

    // 检查是否需要自动脱敏
    const piiFinding = findings.find(f => f.dimension === 'pii_leak');
    const piiRule = rules.find(r => r.dimension === 'pii_leak');
    
    if (piiFinding && piiRule && piiRule.autoMask && piiFinding.score >= piiRule.warnThreshold) {
      return 'mask';
    }

    // 检查是否需要警告
    for (const finding of findings) {
      const rule = rules.find(r => r.dimension === finding.dimension);
      
      if (rule && rule.enabled) {
        if (finding.score >= rule.warnThreshold) {
          return 'warn';
        }
      }
    }

    // 检查是否需要安全改写
    const highRiskFinding = findings.find(f => f.score >= 60 && f.score < 80);
    if (highRiskFinding) {
      const rule = rules.find(r => r.dimension === highRiskFinding.dimension);
      if (rule && rule.autoRewrite) {
        return 'rewrite';
      }
    }

    return 'allow';
  }

  /**
   * 生成摘要
   */
  private generateSummary(findings: RiskFinding[], action: DetectionAction): string {
    const highRiskFindings = findings.filter(f => f.score >= 70);
    const mediumRiskFindings = findings.filter(f => f.score >= 50 && f.score < 70);

    const parts: string[] = [];

    if (highRiskFindings.length > 0) {
      const dimensions = highRiskFindings.map(f => this.getDimensionName(f.dimension));
      parts.push(`高风险维度：${dimensions.join('、')}`);
    }

    if (mediumRiskFindings.length > 0) {
      const dimensions = mediumRiskFindings.map(f => this.getDimensionName(f.dimension));
      parts.push(`中风险维度：${dimensions.join('、')}`);
    }

    if (parts.length === 0) {
      parts.push('未检测到明显风险');
    }

    parts.push(`处理动作：${this.getActionName(action)}`);

    return parts.join('；');
  }

  /**
   * 获取维度名称（统一使用共享维度标签，见 @/lib/dimension-labels）
   */
  private getDimensionName(dimension: string): string {
    return dimensionLabel(dimension);
  }

  /**
   * 获取动作名称
   */
  private getActionName(action: DetectionAction): string {
    const names: Record<DetectionAction, string> = {
      block: '拦截',
      warn: '警告',
      allow: '放行',
      mask: '脱敏',
      rewrite: '安全改写',
    };
    return names[action];
  }

  /**
   * 获取严重程度
   */
  private getSeverity(score: number): 'critical' | 'high' | 'medium' | 'low' {
    if (score >= 90) return 'critical';
    if (score >= 70) return 'high';
    if (score >= 50) return 'medium';
    return 'low';
  }
}

// 单例实例
let orchestratorInstance: DetectionOrchestrator | null = null;

/**
 * 获取检测编排引擎实例
 */
export function getDetectionOrchestrator(): DetectionOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new DetectionOrchestrator();
  }
  return orchestratorInstance;
}

/**
 * 重置检测编排引擎实例（用于测试）
 */
export function resetDetectionOrchestrator(): void {
  orchestratorInstance = null;
}
