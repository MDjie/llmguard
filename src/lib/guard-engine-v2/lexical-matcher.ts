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

  find(text: string, limit: number): readonly { patternIndex: number; end: number }[] {
    const matches: Array<{ patternIndex: number; end: number }> = [];
    let state = 0;
    let offset = 0;
    for (const character of text) {
      while (state !== 0 && !this.nodes[state].next.has(character)) {
        state = this.nodes[state].fail;
      }
      state = this.nodes[state].next.get(character) ?? 0;
      offset += character.length;
      for (const patternIndex of this.nodes[state].outputs) {
        matches.push({ patternIndex, end: offset });
        if (matches.length >= limit) return matches;
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

function approximateMatches(view: NormalizedView, rule: RuleSpec): readonly LexicalMatch[] {
  const config = rule.approximate;
  if (!config) return [];
  const source = rule.caseSensitive ? view.text : fold(view.text);
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
    matches.push({
      ruleId: rule.id,
      raw: view.text.slice(tokenStart, tokenStart + tokenText.length),
      index: tokenStart,
      approximate: true,
      editDistance: distance,
    });
  }
  return matches;
}

export class LexicalMatcher {
  private readonly sensitive: readonly IndexedRule[];
  private readonly insensitive: readonly IndexedRule[];
  private readonly sensitiveAutomaton?: AhoCorasick;
  private readonly insensitiveAutomaton?: AhoCorasick;

  constructor(private readonly rules: readonly RuleSpec[]) {
    rules.forEach(validateApproximateRule);
    this.sensitive = rules
      .filter((rule) => rule.matchType !== 'regex' && rule.caseSensitive)
      .map((rule) => ({ rule, normalizedPattern: rule.pattern }));
    this.insensitive = rules
      .filter((rule) => rule.matchType !== 'regex' && !rule.caseSensitive)
      .map((rule) => ({ rule, normalizedPattern: fold(rule.pattern) }));
    if (this.sensitive.length > 0) {
      this.sensitiveAutomaton = new AhoCorasick(
        this.sensitive.map((entry) => entry.normalizedPattern),
      );
    }
    if (this.insensitive.length > 0) {
      this.insensitiveAutomaton = new AhoCorasick(
        this.insensitive.map((entry) => entry.normalizedPattern),
      );
    }
  }

  find(view: NormalizedView, maximumMatches = 1_000): ReadonlyMap<string, readonly LexicalMatch[]> {
    const byRule = new Map<string, LexicalMatch[]>();
    const collect = (
      text: string,
      entries: readonly IndexedRule[],
      automaton: AhoCorasick | undefined,
    ) => {
      if (!automaton) return;
      for (const found of automaton.find(text, maximumMatches)) {
        const entry = entries[found.patternIndex];
        const start = found.end - entry.normalizedPattern.length;
        const matchType = entry.rule.matchType;
        if (matchType === 'exact' && (start !== 0 || found.end !== text.length)) continue;
        if (matchType === 'prefix' && start !== 0) continue;
        if (matchType === 'suffix' && found.end !== text.length) continue;
        const matches = byRule.get(entry.rule.id) ?? [];
        if (matches.length >= 100) continue;
        matches.push({
          ruleId: entry.rule.id,
          raw: view.text.slice(start, found.end),
          index: start,
          approximate: false,
        });
        byRule.set(entry.rule.id, matches);
      }
    };
    collect(view.text, this.sensitive, this.sensitiveAutomaton);
    collect(fold(view.text), this.insensitive, this.insensitiveAutomaton);
    for (const rule of this.rules) {
      if (!rule.approximate || (byRule.get(rule.id)?.length ?? 0) >= 100) continue;
      const combined = [...(byRule.get(rule.id) ?? []), ...approximateMatches(view, rule)]
        .slice(0, 100);
      if (combined.length > 0) byRule.set(rule.id, combined);
    }
    return byRule;
  }
}
