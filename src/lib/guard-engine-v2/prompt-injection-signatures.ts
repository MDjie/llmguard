import { promptInjectionFamilies } from '../content-safety/prompt-injection-catalog';

export const promptInjectionSignatures = promptInjectionFamilies.flatMap((family) =>
  family.patterns.map((pattern) => ({
    id: `${family.id}_${pattern.locale.toUpperCase()}`,
    riskType: family.riskType,
    pattern: new RegExp(pattern.source, 'giu'),
    score: 0.94,
    severity: 'CRITICAL' as const,
  })),
);

/**
 * Only a whole, explicitly analytical request about one quoted sample qualifies.
 * The sample is still a candidate for semantic review, never a whitelist.
 * Caller must also check the trusted request direction, not a text claim.
 */
export function isQuotedInjectionAnalysis(text: string, start: number, end: number): boolean {
  const pairs: readonly [string, string][] = [['“', '”'], ['「', '」'], ['"', '"'], ['`', '`']];
  for (const [open, close] of pairs) {
    const opening = text.indexOf(open);
    if (opening < 0 || opening >= start) continue;
    const closing = text.indexOf(close, opening + open.length);
    if (closing < end || closing < 0) continue;
    // Extra quoted segments, suffix instructions, and RAG wrappers do not qualify.
    if (!/^[\s?.。？!！]*$/u.test(text.slice(closing + close.length))) continue;
    const prefix = text.slice(0, opening).trim();
    if (/^(?:请)?(?:解释|分析|识别)(?:以下|这段)?(?:提示词注入|提示词攻击|攻击样例|攻击指令)(?:的(?:风险|原理|含义))?\s*[:：]$/u.test(prefix) ||
        /^(?:please\s+)?(?:explain|analy[sz]e|identify)\s+(?:this|the following)\s+(?:prompt injection|attack sample|attack instruction)(?:\s+(?:risk|example))?\s*:$/iu.test(prefix)) return true;
  }
  return false;
}

const phraseSignatures = promptInjectionFamilies.flatMap(family => (['zh', 'en'] as const).flatMap(locale =>
  family.phrases[locale].map((phrase, index) => ({
    id: family.id + '_' + locale + '_' + (index + 1), riskType: family.riskType, locale,
    pattern: new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'),
  })),
));

export function injectionPhraseMatches(text: string) {
  // Case folding can change string length (e.g. U+0130); regex indices retain UTF-16 offsets.
  return phraseSignatures.flatMap(spec => {
    const matches: Array<{ id: string; riskType: string; value: string; index: number }> = [];
    for (const match of text.matchAll(spec.pattern)) {
      if (matches.length >= 16) break;
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (spec.locale === 'en' && (/[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, start - 2), start)) ||
        /^[\p{L}\p{N}_]/u.test(text.slice(end, end + 2)))) continue;
      matches.push({ id: spec.id, riskType: spec.riskType, value: match[0], index: start });
    }
    return matches;
  });
}

/** Local negation of this occurrence only; never suppress another instruction. */
export function isNegatedInjectionInstruction(text: string, start: number, end: number): boolean {
  const prefix = text.slice(Math.max(0, start - 48), start);
  const clause = prefix.slice(Math.max(...['\n', '.', '。', ';', '；', '!', '！'].map(mark => prefix.lastIndexOf(mark))) + 1).trim();
  if (!/^(?:(?:please\s+)?(?:do not|don't|must not|never)|(?:请|請)?(?:不要|不得|禁止|切勿))\s*$/iu.test(clause)) return false;
  // Ambiguous compound negation goes to ordinary detection, not an exemption.
  const matched = text.slice(start, end);
  if (/(?:[\r\n;；.!?。！？]|\b(?:and|but|instead|however|then)\b|但是|然而|改为|改為|然后|然後|并且|並且)/iu.test(matched)) return false;
  const directives = matched.match(/\b(?:ignore|disregard|forget|override|reveal|repeat|print|show|disable|bypass)\b|忽略|无视|無視|忘记|忘記|泄露|输出|輸出|绕过|繞過/giu) ?? [];
  return directives.length <= 1;
}
