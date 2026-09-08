import { assessRuleMatch, ruleMatchConstraintsSchema } from './rule-constraints';
import type { NormalizedView, RuleSpec } from './types';

export interface LexicalMatch {
  readonly ruleId: string;
  readonly raw: string;
  readonly index: number;
  readonly approximate: boolean;
  readonly editDistance?: number;
}

interface TrieNode {
  readonly next: Map<string, number>;
  fail: number;
  readonly outputs: number[];
}

interface IndexedRule {
  readonly rule: RuleSpec;
  readonly normalizedPattern: string;
}

interface FoldedText { readonly text: string; readonly origins?: readonly { start: number; end: number }[] }
function foldWithOrigins(value: string): FoldedText {
  const text = fold(value);
  if (text.length === value.length) return { text };
  const origins: { start: number; end: number }[] = [];
  let offset = 0;
  for (const character of value) {
    for (let i = 0; i < fold(character).length; i++) origins.push({ start: offset, end: offset + character.length });
    offset += character.length;
  }
  return { text, origins };
}
function unfoldRange(source: FoldedText, start: number, end: number) {
  return { start: source.origins?.[start]?.start ?? start, end: source.origins?.[end - 1]?.end ?? end };
}
function fold(value: string): string {
  return value.toLocaleLowerCase('und');
}

class AhoCorasick {
  private readonly nodes: TrieNode[] = [{ next: new Map(), fail: 0, outputs: [] }];

  constructor(private readonly patterns: readonly string[]) {
    patterns.forEach((pattern, patternIndex) => {
      let state = 0;
      for (const character of pattern) {
        const existing = this.nodes[state].next.get(character);
        if (existing !== undefined) {
          state = existing;
          continue;
        }
        const nextState = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, outputs: [] });
        this.nodes[state].next.set(character, nextState);
        state = nextState;
      }
      this.nodes[state].outputs.push(patternIndex);
    });
    const queue: number[] = [];
    for (const nextState of this.nodes[0].next.values()) queue.push(nextState);
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const [character, nextState] of this.nodes[state].next) {
        queue.push(nextState);
        let fallback = this.nodes[state].fail;
        while (fallback !== 0 && !this.nodes[fallback].next.has(character)) {
          fallback = this.nodes[fallback].fail;
        }
        this.nodes[nextState].fail = this.nodes[fallback].next.get(character) ?? 0;
        this.nodes[nextState].outputs.push(
          ...this.nodes[this.nodes[nextState].fail].outputs,
        );
      }
    }
  }

  /**
   * 全文扫描，永不提前停止：提前停止会让攻击者用海量前置命中
   * 把尾部的真实风险挤出扫描窗口。只对每个模式的存储数量封顶，
   * 扫描本身是 O(n)，贵的是证据对象而不是扫描。
   */
  find(text: string, perPatternLimit: number, accept: (patternIndex: number, end: number) => boolean): readonly { patternIndex: number; end: number }[] {
    const matches: Array<{ patternIndex: number; end: number }> = [];
    const perPatternCounts = new Int32Array(this.patterns.length);
    let state = 0;
    let offset = 0;
    for (const character of text) {
      while (state !== 0 && !this.nodes[state].next.has(character)) {
        state = this.nodes[state].fail;
      }
      state = this.nodes[state].next.get(character) ?? 0;
      offset += character.length;
      for (const patternIndex of this.nodes[state].outputs) {
        if (perPatternCounts[patternIndex] >= perPatternLimit || !accept(patternIndex, offset)) continue;
        perPatternCounts[patternIndex] += 1;
        matches.push({ patternIndex, end: offset });
      }
    }
    return matches;
  }
}

function boundedDamerauLevenshtein(left: string, right: string, maximum: number): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previousPrevious: number[] | undefined;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      let value = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        substitution,
      );
      if (
        previousPrevious &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        value = Math.min(value, previousPrevious[rightIndex - 2] + 1);
      }
      current[rightIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length];
}

function validateApproximateRule(rule: RuleSpec): void {
  const approximate = rule.approximate;
  if (!approximate) return;
  if (
    rule.matchType === 'regex' ||
    rule.pattern.length < 4 ||
    approximate.maxPatternLength < 4 ||
    approximate.maxPatternLength > 64 ||
    rule.pattern.length > approximate.maxPatternLength ||
    approximate.maxCandidates < 1 ||
    approximate.maxCandidates > 64
  ) {
    throw new Error(`RULE_APPROXIMATE_CONFIG_INVALID:${rule.id}`);
  }
}

function approximateMatches(view: NormalizedView, rule: RuleSpec, accept?: (rule: RuleSpec, start: number, end: number) => boolean): readonly LexicalMatch[] {
  const config = rule.approximate;
  if (!config) return [];
  const foldedSource = rule.caseSensitive ? { text: view.text } : foldWithOrigins(view.text);
  const source = foldedSource.text;
  const pattern = rule.caseSensitive ? rule.pattern : fold(rule.pattern);
  const minimumLength = Math.max(1, pattern.length - config.maxEditDistance);
  const maximumLength = pattern.length + config.maxEditDistance;
  const matches: LexicalMatch[] = [];
  const tokenPattern = /[\p{L}\p{N}_-]+/gu;
  for (const token of source.matchAll(tokenPattern)) {
    if (matches.length >= config.maxCandidates) break;
    const tokenStart = token.index ?? 0;
    const tokenText = token[0];
    if (tokenText.length < minimumLength || tokenText.length > maximumLength) continue;
    const distance = boundedDamerauLevenshtein(tokenText, pattern, config.maxEditDistance);
    if (distance === 0 || distance > config.maxEditDistance) continue;
    const range = unfoldRange(foldedSource, tokenStart, tokenStart + tokenText.length);
    if (!assessRuleMatch(view.text, range, rule.matchConstraints, rule.caseSensitive).matched || !(accept?.(rule, range.start, range.end) ?? true)) continue;
    matches.push({
      ruleId: rule.id,
      raw: view.text.slice(range.start, range.end),
      index: range.start,
      approximate: true,
      editDistance: distance,
    });
  }
  return matches;
}

function indexed(rule: RuleSpec): IndexedRule {
  return {
    rule,
    normalizedPattern: rule.caseSensitive ? rule.pattern : fold(rule.pattern),
  };
}

function anchoredMatch(
  text: string,
  entry: IndexedRule,
): { raw: string; index: number } | null {
  const { rule, normalizedPattern } = entry;
  if (rule.matchType === 'exact') {
    return text === normalizedPattern ? { raw: text, index: 0 } : null;
  }
  if (rule.matchType === 'prefix') {
    if (!text.startsWith(normalizedPattern)) return null;
    return { raw: text.slice(0, normalizedPattern.length), index: 0 };
  }
  if (!text.endsWith(normalizedPattern)) return null;
  const index = text.length - normalizedPattern.length;
  return { raw: text.slice(index), index };
}

export class LexicalMatcher {
  private readonly containsSensitive: readonly IndexedRule[];
  private readonly containsInsensitive: readonly IndexedRule[];
  private readonly anchoredSensitive: readonly IndexedRule[];
  private readonly anchoredInsensitive: readonly IndexedRule[];
  private readonly sensitiveAutomaton?: AhoCorasick;
  private readonly insensitiveAutomaton?: AhoCorasick;

  constructor(private readonly rules: readonly RuleSpec[]) {
    rules.forEach(validateApproximateRule);
    rules.forEach(rule => { if (rule.matchConstraints) ruleMatchConstraintsSchema.parse(rule.matchConstraints); });
    const lexical = rules.filter((rule) => rule.matchType !== 'regex');
    const anchored = lexical.filter((rule) => rule.matchType !== 'contains');
    // 锚定匹配（exact/prefix/suffix）每视图至多 1 次命中，直接字符串检查即可，
    // 走自动机反而可能被同模式的其他位置命中挤出存储窗口
    this.anchoredSensitive = anchored.filter((rule) => rule.caseSensitive).map(indexed);
    this.anchoredInsensitive = anchored.filter((rule) => !rule.caseSensitive).map(indexed);
    this.containsSensitive = lexical
      .filter((rule) => rule.matchType === 'contains' && rule.caseSensitive)
      .map(indexed);
    this.containsInsensitive = lexical
      .filter((rule) => rule.matchType === 'contains' && !rule.caseSensitive)
      .map(indexed);
    if (this.containsSensitive.length > 0) {
      this.sensitiveAutomaton = new AhoCorasick(
        this.containsSensitive.map((entry) => entry.normalizedPattern),
      );
    }
    if (this.containsInsensitive.length > 0) {
      this.insensitiveAutomaton = new AhoCorasick(
        this.containsInsensitive.map((entry) => entry.normalizedPattern),
      );
    }
  }

  find(view: NormalizedView, accept?: (rule: RuleSpec, start: number, end: number) => boolean): ReadonlyMap<string, readonly LexicalMatch[]> {
    const byRule = new Map<string, LexicalMatch[]>();
    const collect = (
      source: FoldedText,
      entries: readonly IndexedRule[],
      automaton: AhoCorasick | undefined,
    ) => {
      if (!automaton) return;
      const text = source.text;
      // 每规则证据封顶而非抛错：容量超限此前会被 required+fail-closed 链路
      // 转化为强制拦截，攻击者可借“让某词典词出现 101 次”定向拒绝业务；
      // 扫描始终覆盖全文，截断只影响证据数量，不影响命中判定
      const foundMatches = automaton.find(text, 100, (index,end) => {
        const entry=entries[index];
        const range = unfoldRange(source,end-entry.normalizedPattern.length,end);
        return assessRuleMatch(view.text,range,entry.rule.matchConstraints,entry.rule.caseSensitive).matched && (accept?.(entry.rule,range.start,range.end) ?? true);
      });
      for (const found of foundMatches) {
        const entry = entries[found.patternIndex];
        const range = unfoldRange(source,found.end - entry.normalizedPattern.length,found.end);
        const start = range.start;
        const matches = byRule.get(entry.rule.id) ?? [];
        if (matches.length >= 100) continue;
        matches.push({
          ruleId: entry.rule.id,
          raw: view.text.slice(start, range.end),
          index: start,
          approximate: false,
        });
        byRule.set(entry.rule.id, matches);
      }
    };
    collect({ text: view.text }, this.containsSensitive, this.sensitiveAutomaton);
    const folded = this.insensitiveAutomaton || this.anchoredInsensitive.length > 0
      ? foldWithOrigins(view.text)
      : undefined;
    if (folded !== undefined) {
      collect(folded, this.containsInsensitive, this.insensitiveAutomaton);
      for (const entry of this.anchoredInsensitive) {
        const match = anchoredMatch(folded.text, entry);
        const range = match ? unfoldRange(folded, match.index, match.index + match.raw.length) : undefined;
        if (range && assessRuleMatch(view.text,range,entry.rule.matchConstraints,entry.rule.caseSensitive).matched && (accept?.(entry.rule,range.start,range.end) ?? true)) {
          byRule.set(entry.rule.id, [{
            ruleId: entry.rule.id,
            raw: view.text.slice(range.start, range.end),
            index: range.start,
            approximate: false,
          }]);
        }
      }
    }
    for (const entry of this.anchoredSensitive) {
      const match = anchoredMatch(view.text, entry);
      if (match && assessRuleMatch(view.text,{start:match.index,end:match.index+match.raw.length},entry.rule.matchConstraints,entry.rule.caseSensitive).matched && (accept?.(entry.rule,match.index,match.index+match.raw.length) ?? true)) {
        byRule.set(entry.rule.id, [{
          ruleId: entry.rule.id,
          raw: view.text.slice(match.index, match.index + match.raw.length),
          index: match.index,
          approximate: false,
        }]);
      }
    }
    for (const rule of this.rules) {
      if (!rule.approximate || (byRule.get(rule.id)?.length ?? 0) >= 100) continue;
      const combined = [...(byRule.get(rule.id) ?? []), ...approximateMatches(view, rule, accept)]
        .slice(0, 100);
      if (combined.length > 0) byRule.set(rule.id, combined);
    }
    return byRule;
  }
}
