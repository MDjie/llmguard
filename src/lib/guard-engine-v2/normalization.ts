import type {
  NormalizationTransform,
  NormalizedView,
  OriginSpan,
} from './types';

export const NORMALIZATION_ALGORITHM_VERSION = 'guard-normalization-3.0.0';

export interface NormalizationBudget {
  readonly maxRounds: number;
  readonly maxDepth: number;
  readonly maxViews: number;
  readonly maxBranchesPerView: number;
  readonly maxViewChars: number;
  readonly maxTotalBytes: number;
  readonly maxExpansionRatio: number;
  readonly maxCpuMs: number;
}

export interface NormalizationResult {
  readonly algorithmVersion: string;
  readonly views: readonly NormalizedView[];
  readonly totalOutputBytes: number;
  readonly elapsedMs: number;
}

interface CandidateView {
  readonly text: string;
  readonly originSpans: readonly OriginSpan[];
  readonly method: string;
  readonly confidence: number;
}

interface Decoder {
  readonly id: string;
  readonly decode: (view: NormalizedView) => readonly CandidateView[];
}

const DEFAULT_BUDGET: NormalizationBudget = {
  maxRounds: 3,
  maxDepth: 3,
  maxViews: 24,
  maxBranchesPerView: 16,
  maxViewChars: 1_048_576,
  maxTotalBytes: 4 * 1_048_576,
  maxExpansionRatio: 16,
  maxCpuMs: 250,
};

const ZERO_WIDTH_OR_BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;
const HTML_ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/giu;
const BASE64_TOKEN = /(?:base64\s*:\s*)?((?:[A-Za-z0-9+/]{4}){4,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)/giu;
const BASE32_TOKEN = /(?:base32\s*:\s*)?([A-Z2-7]{8,}={0,6})/giu;
const HEX_TOKEN = /(?:hex\s*:\s*)?((?:[0-9a-f]{2}){4,})/giu;
const QUOTED_PRINTABLE = /(?:=[0-9a-f]{2}){4,}/iu;
const ROT13_PREFIX = /\brot13\s*:\s*([^\r\n]{4,})/giu;
const ESCAPED_CODE_POINT = /\\(?:x([0-9a-f]{2})|u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4}))/giu;
const SLICED_TOKEN = /(?:[\p{L}\p{N}][\s\p{P}\p{S}_]{1,3}){3,}[\p{L}\p{N}]/gu;

const CONFUSABLES: Readonly<Record<string, string>> = {
  'Α': 'A', 'А': 'A', 'Ꭺ': 'A', 'Β': 'B', 'В': 'B', 'Ᏼ': 'B',
  'Ϲ': 'C', 'С': 'C', 'Ⅾ': 'D', 'Ε': 'E', 'Е': 'E', 'Ꭼ': 'E',
  'Η': 'H', 'Н': 'H', 'Ι': 'I', 'І': 'I', 'Ӏ': 'I', 'Ј': 'J',
  'Κ': 'K', 'К': 'K', 'Μ': 'M', 'М': 'M', 'Ν': 'N', 'О': 'O',
  'Ο': 'O', 'Ρ': 'P', 'Р': 'P', 'Ѕ': 'S', 'Τ': 'T', 'Т': 'T',
  'Χ': 'X', 'Х': 'X', 'Υ': 'Y', 'Ү': 'Y', 'Ζ': 'Z',
  'ɑ': 'a', 'а': 'a', 'ϲ': 'c', 'с': 'c', 'ԁ': 'd', 'е': 'e',
  'ɡ': 'g', 'һ': 'h', 'і': 'i', 'ӏ': 'l', 'ј': 'j', 'ո': 'n',
  'ο': 'o', 'о': 'o', 'р': 'p', 'ѕ': 's', 'υ': 'u', 'у': 'y',
  'х': 'x', 'ᴢ': 'z',
};

const LEETSPEAK: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
  '@': 'a', '$': 's', '!': 'i',
};

const PHONETIC_ALIASES: readonly {
  readonly pattern: RegExp;
  readonly replacement: string;
}[] = [
  { pattern: /\bhu\s*lue\s*zhi\s*qian\s*(?:zhi\s*ling|gui\s*ze)\b/giu, replacement: '忽略之前指令' },
  { pattern: /\bwu\s*shi\s*(?:xi\s*tong|kai\s*fa\s*zhe)\s*(?:ti\s*shi\s*ci|zhi\s*ling)\b/giu, replacement: '无视系统提示词' },
  { pattern: /\bxie\s*lu\s*(?:xi\s*tong|kai\s*fa\s*zhe)\s*(?:ti\s*shi\s*ci|zhi\s*ling)\b/giu, replacement: '泄露系统提示词' },
  { pattern: /\brao\s*guo\s*(?:an\s*quan|shen\s*cha|guo\s*lv)\b/giu, replacement: '绕过安全审查' },
];

export class NormalizationBudgetExceededError extends Error {
  readonly code = 'RESOURCE_BUDGET_EXCEEDED';

  constructor(readonly budgetName: keyof NormalizationBudget) {
    super('RESOURCE_BUDGET_EXCEEDED');
    this.name = 'NormalizationBudgetExceededError';
  }
}

function appendMapped(
  parts: string[],
  spans: OriginSpan[],
  value: string,
  span: OriginSpan,
): void {
  parts.push(value);
  for (let index = 0; index < value.length; index += 1) spans.push(span);
}

function mappedSpan(view: NormalizedView, start: number, end: number): OriginSpan {
  if (start === end) {
    return view.originSpans[start] ?? view.originSpans[start - 1] ?? { start: 0, end: 0 };
  }
  const selected = view.originSpans.slice(start, end);
  return {
    start: Math.min(...selected.map((span) => span.start)),
    end: Math.max(...selected.map((span) => span.end)),
  };
}

function wholeViewCandidate(
  view: NormalizedView,
  method: string,
  text: string,
  confidence: number,
): CandidateView {
  const span = mappedSpan(view, 0, view.text.length);
  return {
    text,
    method,
    confidence,
    originSpans: Array.from({ length: text.length }, () => span),
  };
}

function characterTransform(
  view: NormalizedView,
  method: string,
  confidence: number,
  transform: (character: string) => string,
): readonly CandidateView[] {
  const parts: string[] = [];
  const spans: OriginSpan[] = [];
  let changed = false;
  let offset = 0;
  for (const character of view.text) {
    const start = offset;
    offset += character.length;
    const replacement = transform(character);
    if (replacement !== character) changed = true;
    if (replacement.length > 0) {
      appendMapped(parts, spans, replacement, mappedSpan(view, start, offset));
    }
  }
  return changed ? [{ text: parts.join(''), originSpans: spans, method, confidence }] : [];
}

function unicodeCandidates(view: NormalizedView): readonly CandidateView[] {
  return characterTransform(view, 'unicode_nfkc_controls', 1, (character) =>
    ZERO_WIDTH_OR_BIDI.test(character) ? '' : character.normalize('NFKC'));
}

function caseFoldCandidates(view: NormalizedView): readonly CandidateView[] {
  return characterTransform(view, 'unicode_casefold', 1, (character) => character.toLocaleLowerCase('und'));
}

function confusableCandidates(view: NormalizedView): readonly CandidateView[] {
  return characterTransform(view, 'confusable_skeleton', 0.98, (character) =>
    CONFUSABLES[character] ?? character);
}

function leetspeakCandidates(view: NormalizedView): readonly CandidateView[] {
  if (!/[013457@$!]/u.test(view.text)) return [];
  return characterTransform(view, 'leetspeak_skeleton', 0.9, (character) =>
    LEETSPEAK[character] ?? character);
}

function slicedTokenCandidates(view: NormalizedView): readonly CandidateView[] {
  const matches = [...view.text.matchAll(SLICED_TOKEN)];
  if (matches.length === 0) return [];
  const parts: string[] = [];
  const spans: OriginSpan[] = [];
  let cursor = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > cursor) {
      parts.push(view.text.slice(cursor, start));
      spans.push(...view.originSpans.slice(cursor, start));
    }
    let localOffset = start;
    for (const character of match[0]) {
      const characterStart = localOffset;
      localOffset += character.length;
      if (![...character].some((item) => /[\p{L}\p{N}]/u.test(item))) continue;
      appendMapped(parts, spans, character, mappedSpan(view, characterStart, localOffset));
    }
    cursor = end;
  }
  if (cursor < view.text.length) {
    parts.push(view.text.slice(cursor));
    spans.push(...view.originSpans.slice(cursor));
  }
  return [{
    text: parts.join(''),
    originSpans: spans,
    method: 'sliced_token_reassembly',
    confidence: 0.88,
  }];
}

function replaceMappedRanges(
  view: NormalizedView,
  method: string,
  confidence: number,
  replacements: readonly { readonly start: number; readonly end: number; readonly value: string }[],
): readonly CandidateView[] {
  if (replacements.length === 0) return [];
  const parts: string[] = [];
  const spans: OriginSpan[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < cursor) continue;
    parts.push(view.text.slice(cursor, replacement.start));
    spans.push(...view.originSpans.slice(cursor, replacement.start));
    appendMapped(
      parts,
      spans,
      replacement.value,
      mappedSpan(view, replacement.start, replacement.end),
    );
    cursor = replacement.end;
  }
  parts.push(view.text.slice(cursor));
  spans.push(...view.originSpans.slice(cursor));
  return [{ text: parts.join(''), originSpans: spans, method, confidence }];
}

function phoneticCandidates(view: NormalizedView): readonly CandidateView[] {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const alias of PHONETIC_ALIASES) {
    alias.pattern.lastIndex = 0;
    for (const match of view.text.matchAll(alias.pattern)) {
      const start = match.index ?? 0;
      replacements.push({ start, end: start + match[0].length, value: alias.replacement });
    }
  }
  replacements.sort((left, right) => left.start - right.start || right.end - left.end);
  return replaceMappedRanges(view, 'curated_phonetic_alias', 0.86, replacements);
}

function decodeHtmlEntity(entity: string): string {
  const lower = entity.toLowerCase();
  if (lower === '&amp;') return '&';
  if (lower === '&lt;') return '<';
  if (lower === '&gt;') return '>';
  if (lower === '&quot;') return '"';
  if (lower === '&apos;') return "'";
  const decimal = lower.match(/^&#(\d+);$/u);
  const hexadecimal = lower.match(/^&#x([0-9a-f]+);$/u);
  const codePoint = decimal
    ? Number.parseInt(decimal[1], 10)
    : hexadecimal
      ? Number.parseInt(hexadecimal[1], 16)
      : Number.NaN;
  return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : entity;
}

function htmlCandidates(view: NormalizedView): readonly CandidateView[] {
  const replacements = [...view.text.matchAll(HTML_ENTITY)].map((match) => {
    const start = match.index ?? 0;
    return { start, end: start + match[0].length, value: decodeHtmlEntity(match[0]) };
  });
  return replaceMappedRanges(view, 'html_entity', 0.99, replacements);
}

function urlCandidates(view: NormalizedView): readonly CandidateView[] {
  if (!/%[0-9a-f]{2}/iu.test(view.text)) return [];
  try {
    const decoded = decodeURIComponent(view.text.replace(/\+/gu, '%20'));
    return decoded === view.text ? [] : [wholeViewCandidate(view, 'url_percent', decoded, 0.98)];
  } catch {
    return [];
  }
}

function escapedCandidates(view: NormalizedView): readonly CandidateView[] {
  const replacements = [...view.text.matchAll(ESCAPED_CODE_POINT)].flatMap((match) => {
    const codePoint = Number.parseInt(match[1] ?? match[2] ?? match[3], 16);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) return [];
    const start = match.index ?? 0;
    return [{ start, end: start + match[0].length, value: String.fromCodePoint(codePoint) }];
  });
  return replaceMappedRanges(view, 'escaped_code_points', 0.99, replacements);
}

function printableRatio(value: string): number {
  const characters = [...value];
  if (characters.length === 0) return 0;
  return characters.filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || code >= 32;
  }).length / characters.length;
}

function decodedTokenCandidates(
  view: NormalizedView,
  method: string,
  confidence: number,
  matches: IterableIterator<RegExpMatchArray>,
  decode: (value: string) => string | null,
  capture = 1,
  limit = 8,
): readonly CandidateView[] {
  const candidates: CandidateView[] = [];
  for (const match of matches) {
    if (candidates.length >= limit) break;
    const encoded = match[capture] ?? match[0];
    const decoded = decode(encoded);
    if (!decoded || decoded.includes('\uFFFD') || printableRatio(decoded) < 0.85) continue;
    const start = (match.index ?? 0) + match[0].indexOf(encoded);
    candidates.push({
      text: decoded,
      method,
      confidence,
      originSpans: Array.from(
        { length: decoded.length },
        () => mappedSpan(view, start, start + encoded.length),
      ),
    });
  }
  return candidates;
}

function base64Candidates(view: NormalizedView): readonly CandidateView[] {
  return decodedTokenCandidates(
    view,
    'base64',
    0.97,
    view.text.matchAll(BASE64_TOKEN),
    (value) => {
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        return decoded || null;
      } catch {
        return null;
      }
    },
  );
}

function decodeBase32(value: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = value.toUpperCase().replace(/=+$/u, '');
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      if (bytes.length > DEFAULT_BUDGET.maxViewChars * 4) return null;
    }
  }
  return Buffer.from(bytes).toString('utf8') || null;
}

function base32Candidates(view: NormalizedView): readonly CandidateView[] {
  return decodedTokenCandidates(
    view,
    'base32',
    0.96,
    view.text.matchAll(BASE32_TOKEN),
    decodeBase32,
    1,
    4,
  );
}

function hexCandidates(view: NormalizedView): readonly CandidateView[] {
  return decodedTokenCandidates(
    view,
    'hex',
    0.96,
    view.text.matchAll(HEX_TOKEN),
    (value) => {
      try {
        return Buffer.from(value, 'hex').toString('utf8') || null;
      } catch {
        return null;
      }
    },
    1,
    4,
  );
}

function quotedPrintableCandidates(view: NormalizedView): readonly CandidateView[] {
  if (!QUOTED_PRINTABLE.test(view.text)) return [];
  const decoded = view.text.replace(/=([0-9a-f]{2})/giu, (_match, byte: string) =>
    String.fromCharCode(Number.parseInt(byte, 16)));
  return decoded === view.text || printableRatio(decoded) < 0.85
    ? []
    : [wholeViewCandidate(view, 'quoted_printable', decoded, 0.97)];
}

function rot13Candidates(view: NormalizedView): readonly CandidateView[] {
  return [...view.text.matchAll(ROT13_PREFIX)].slice(0, 2).map((match) => {
    const value = match[1].replace(/[A-Za-z]/gu, (character) => {
      const base = character <= 'Z' ? 65 : 97;
      return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
    });
    const start = (match.index ?? 0) + match[0].indexOf(match[1]);
    return {
      text: value,
      method: 'rot13',
      confidence: 0.95,
      originSpans: Array.from(
        { length: value.length },
        () => mappedSpan(view, start, start + match[1].length),
      ),
    };
  });
}

export const NORMALIZATION_DECODER_REGISTRY: readonly Decoder[] = [
  { id: 'unicode_nfkc_controls', decode: unicodeCandidates },
  { id: 'unicode_casefold', decode: caseFoldCandidates },
  { id: 'confusable_skeleton', decode: confusableCandidates },
  { id: 'leetspeak_skeleton', decode: leetspeakCandidates },
  { id: 'sliced_token_reassembly', decode: slicedTokenCandidates },
  { id: 'curated_phonetic_alias', decode: phoneticCandidates },
  { id: 'html_entity', decode: htmlCandidates },
  { id: 'url_percent', decode: urlCandidates },
  { id: 'escaped_code_points', decode: escapedCandidates },
  { id: 'base64', decode: base64Candidates },
  { id: 'base32', decode: base32Candidates },
  { id: 'hex', decode: hexCandidates },
  { id: 'quoted_printable', decode: quotedPrintableCandidates },
  { id: 'rot13', decode: rot13Candidates },
];

function positiveInteger(value: number, name: keyof NormalizationBudget): number {
  if (!Number.isInteger(value) || value <= 0) throw new NormalizationBudgetExceededError(name);
  return value;
}

function resolvedBudget(overrides: Partial<NormalizationBudget>): NormalizationBudget {
  const merged = { ...DEFAULT_BUDGET, ...overrides };
  return {
    maxRounds: positiveInteger(merged.maxRounds, 'maxRounds'),
    maxDepth: positiveInteger(merged.maxDepth, 'maxDepth'),
    maxViews: positiveInteger(merged.maxViews, 'maxViews'),
    maxBranchesPerView: positiveInteger(merged.maxBranchesPerView, 'maxBranchesPerView'),
    maxViewChars: positiveInteger(merged.maxViewChars, 'maxViewChars'),
    maxTotalBytes: positiveInteger(merged.maxTotalBytes, 'maxTotalBytes'),
    maxExpansionRatio: positiveInteger(merged.maxExpansionRatio, 'maxExpansionRatio'),
    maxCpuMs: positiveInteger(merged.maxCpuMs, 'maxCpuMs'),
  };
}

function assertCandidateBudget(
  candidate: CandidateView,
  inputBytes: number,
  totalBytes: number,
  budget: NormalizationBudget,
): number {
  if (candidate.text.length > budget.maxViewChars) {
    throw new NormalizationBudgetExceededError('maxViewChars');
  }
  const candidateBytes = Buffer.byteLength(candidate.text, 'utf8');
  if (candidateBytes > Math.max(1, inputBytes) * budget.maxExpansionRatio) {
    throw new NormalizationBudgetExceededError('maxExpansionRatio');
  }
  if (totalBytes + candidateBytes > budget.maxTotalBytes) {
    throw new NormalizationBudgetExceededError('maxTotalBytes');
  }
  if (candidate.originSpans.length !== candidate.text.length) {
    throw new Error('NORMALIZATION_PROVENANCE_INVALID');
  }
  return candidateBytes;
}

export function normalizeWithBudget(
  input: string,
  overrides: Partial<NormalizationBudget> = {},
  now: () => number = () => performance.now(),
): NormalizationResult {
  const budget = resolvedBudget(overrides);
  const startedAt = now();
  const inputBytes = Buffer.byteLength(input, 'utf8');
  if (input.length > budget.maxViewChars) {
    throw new NormalizationBudgetExceededError('maxViewChars');
  }
  if (inputBytes > budget.maxTotalBytes) {
    throw new NormalizationBudgetExceededError('maxTotalBytes');
  }
  const original: NormalizedView = {
    id: 'original',
    text: input,
    originSpans: Array.from({ length: input.length }, (_, index) => ({
      start: index,
      end: index + 1,
    })),
    transforms: [],
    confidence: 1,
    depth: 0,
  };
  const views: NormalizedView[] = [original];
  const queue: NormalizedView[] = [original];
  const seenText = new Set([input]);
  const methodSequences = new Map<string, number>();
  let totalOutputBytes = inputBytes;

  while (queue.length > 0 && views.length < budget.maxViews) {
    if (now() - startedAt > budget.maxCpuMs) {
      throw new NormalizationBudgetExceededError('maxCpuMs');
    }
    const source = queue.shift()!;
    const sourceDepth = source.depth ?? 0;
    if (sourceDepth >= Math.min(budget.maxDepth, budget.maxRounds)) continue;
    let branchCount = 0;
    for (const decoder of NORMALIZATION_DECODER_REGISTRY) {
      const candidates = decoder.decode(source);
      branchCount += candidates.length;
      if (branchCount > budget.maxBranchesPerView) {
        throw new NormalizationBudgetExceededError('maxBranchesPerView');
      }
      for (const candidate of candidates) {
        if (seenText.has(candidate.text)) continue;
        const candidateBytes = assertCandidateBudget(
          candidate,
          inputBytes,
          totalOutputBytes,
          budget,
        );
        if (views.length >= budget.maxViews) break;
        const sequence = methodSequences.get(candidate.method) ?? 0;
        methodSequences.set(candidate.method, sequence + 1);
        const transform: NormalizationTransform = {
          method: candidate.method,
          round: sourceDepth + 1,
          confidence: candidate.confidence,
          sourceViewId: source.id,
        };
        const viewId = candidate.method === 'unicode_nfkc_controls' && sequence === 0
          ? 'unicode_nfkc'
          : `${candidate.method}_${sequence}`;
        const view: NormalizedView = {
          id: viewId,
          text: candidate.text,
          originSpans: candidate.originSpans,
          transforms: [...(source.transforms ?? []), transform],
          confidence: Math.min(source.confidence ?? 1, candidate.confidence),
          depth: sourceDepth + 1,
          sourceViewId: source.id,
        };
        seenText.add(candidate.text);
        totalOutputBytes += candidateBytes;
        views.push(view);
        queue.push(view);
      }
      if (views.length >= budget.maxViews) break;
    }
  }

  const elapsedMs = now() - startedAt;
  if (elapsedMs > budget.maxCpuMs) {
    throw new NormalizationBudgetExceededError('maxCpuMs');
  }
  return {
    algorithmVersion: NORMALIZATION_ALGORITHM_VERSION,
    views,
    totalOutputBytes,
    elapsedMs,
  };
}

export function buildNormalizedViews(
  input: string,
  budget: Partial<NormalizationBudget> = {},
): readonly NormalizedView[] {
  return normalizeWithBudget(input, budget).views;
}

export function normalizationTransformNames(view: NormalizedView): readonly string[] {
  return [...new Set((view.transforms ?? []).map((transform) =>
    `${transform.method}@${transform.round}`))];
}

export function mapViewRange(
  view: NormalizedView,
  start: number,
  end: number,
): OriginSpan {
  if (start < 0 || end < start || end > view.text.length) {
    throw new RangeError('normalized view range is invalid');
  }
  return mappedSpan(view, start, end);
}
