import { compileSafeRegex, safeRegexMatches, safeRegexTest } from '@/lib/detection/safe-regex';
import type { z } from 'zod';
import type { ruleFieldsSchema } from '@/contracts/http/dimensions';

export type EditableRule = z.infer<typeof ruleFieldsSchema>;
export function normalizeRule(rule: EditableRule): EditableRule {
  const normalized = { ...rule, matchType: rule.type === 'regex' ? 'regex' as const : rule.matchType };
  if ((rule.type === 'keyword' || rule.type === 'regex') && !rule.pattern.trim()) throw new Error('关键词和正则规则必须填写匹配内容');
  if (normalized.matchType === 'regex') {
    try { compileSafeRegex(rule.pattern, rule.caseSensitive ? '' : 'i'); }
    catch { throw new Error('正则表达式无效或包含不支持的语法'); }
  }
  return normalized;
}
export interface TestableRule {
  id: string; name: string; type: string; pattern: string | null; matchType: string;
  caseSensitive: boolean; score: string | number; confidence: string | number; enabled: boolean;
}
export function testLocalRules(text: string, rules: readonly TestableRule[], weight: number) {
  const enabled = rules.filter(rule => rule.enabled);
  const skippedRules = enabled.filter(rule => !['keyword', 'regex'].includes(rule.type)).map(rule => ({ id: rule.id, name: rule.name, reason: '此入口仅测试关键词与正则；语义规则请在策略验证中测试' }));
  const evidence: string[] = [];
  const matchedRules = enabled.filter(rule => {
    if (!['keyword', 'regex'].includes(rule.type) || !rule.pattern) return false;
    const search = rule.caseSensitive ? text : text.toLowerCase();
    const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
    const type = rule.type === 'regex' ? 'regex' : rule.matchType;
    const matched = type === 'regex' ? safeRegexTest(text, rule.pattern, rule.caseSensitive)
      : type === 'exact' ? search === pattern : type === 'prefix' ? search.startsWith(pattern)
      : type === 'suffix' ? search.endsWith(pattern) : search.includes(pattern);
    if (matched) evidence.push(...(type === 'regex' ? safeRegexMatches(text, rule.pattern, rule.caseSensitive).slice(0, 3).map(match => match.raw) : [rule.pattern]));
    return matched;
  });
  const scores = matchedRules.map(rule => Number(rule.score)).sort((a,b) => b-a);
  return { score: Math.round(Math.min(100, ((scores[0] ?? 0) + scores.slice(1).reduce((sum,score) => sum+score*0.2,0)) * weight)),
    matchedCount: matchedRules.length, ruleCount: enabled.length - skippedRules.length, matchedRules, evidence: [...new Set(evidence)], skippedRules };
}
