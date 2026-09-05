import type { IRiskDetector, RiskFinding } from '../types';
import { buildNormalizedViews, mapViewRange } from '../../guard-engine-v2/normalization';
import { injectionPhraseMatches, isNegatedInjectionInstruction, isQuotedInjectionAnalysis, promptInjectionSignatures } from '../../guard-engine-v2/prompt-injection-signatures';

/** Compatibility adapter. Shares the bilingual catalog, not broad noun blacklists. */
export class PromptInjectionDetector implements IRiskDetector {
  readonly dimension = 'prompt_injection';

  async detect(text: string): Promise<RiskFinding> {
    if (!text || typeof text !== 'string') return {
      dimension: this.dimension, score: 0, confidence: 0.5, severity: 'low',
      matchedRules: [], evidence: [], reason: '输入文本为空或无效', suggestion: '请提供有效的输入文本',
    };
    const matchedRules = new Set<string>();
    const evidence = new Set<string>();
    let score = 10;
    for (const view of buildNormalizedViews(text)) {
      for (const spec of promptInjectionSignatures) {
        let count = 0;
        for (const match of view.text.matchAll(spec.pattern)) {
          if (++count > 16) break;
          const start = match.index ?? 0;
          const origin = mapViewRange(view, start, start + match[0].length);
          const quoted = isQuotedInjectionAnalysis(text, origin.start, origin.end) ||
            isNegatedInjectionInstruction(text, origin.start, origin.end);
          matchedRules.add('pattern:' + spec.id);
          evidence.add(text.slice(origin.start, origin.end));
          score = Math.max(score, quoted ? 55 : Math.round(spec.score * 100));
        }
      }
      for (const match of injectionPhraseMatches(view.text)) {
        const origin = mapViewRange(view, match.index, match.index + match.value.length);
        const quoted = isQuotedInjectionAnalysis(text, origin.start, origin.end) ||
          isNegatedInjectionInstruction(text, origin.start, origin.end);
        matchedRules.add('candidate:' + match.id);
        evidence.add(text.slice(origin.start, origin.end));
        score = Math.max(score, quoted ? 55 : 60);
      }
    }
    return {
      dimension: this.dimension, score, confidence: matchedRules.size ? 0.85 : 0.5,
      severity: score >= 90 ? 'critical' : score >= 70 ? 'high' : score >= 50 ? 'medium' : 'low',
      matchedRules: [...matchedRules], evidence: [...evidence].slice(0, 100),
      reason: score >= 90 ? '命中提示词注入组合规则（启发式分数，非校准概率）'
        : score >= 50 ? '命中候选短语或分析性引用，需上下文语义复核' : '未命中已知提示词注入规则，不代表完整安全证明',
      suggestion: score >= 90 ? '结合来源权限与策略处置，并记录命中证据'
        : score >= 50 ? '提交语义裁判或人工复核，不因候选词直接阻断' : '继续执行必要的上下文和工具权限检查',
    };
  }
}
