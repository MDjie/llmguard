import { RE2 } from 're2-wasm';

const MAX_PATTERN_LENGTH = 4_096;
const MAX_INPUT_LENGTH = 1_048_576;
const MAX_REPEAT_COPIES = 4_095;
const MAX_MATCHES = 10_000;
const ALLOWED_FLAGS = new Set(['g', 'i', 'm', 's', 'u']);
const compiledCache = new Map<string, RE2>();

export class UnsafeRegexError extends Error {
  constructor(
    readonly code:
      | 'PATTERN_EMPTY'
      | 'PATTERN_TOO_LARGE'
      | 'INPUT_TOO_LARGE'
      | 'FLAGS_UNSUPPORTED'
      | 'PATTERN_UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeRegexError';
  }
}

export function normalizeRegexPattern(pattern: string): string {
  let normalized = pattern.trim();
  const slashFormat = normalized.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  if (slashFormat) normalized = slashFormat[1];
  return normalized
    .replace(/\\\\d/g, '\\d')
    .replace(/\\\\D/g, '\\D')
    .replace(/\\\\s/g, '\\s')
    .replace(/\\\\S/g, '\\S')
    .replace(/\\\\w/g, '\\w')
    .replace(/\\\\W/g, '\\W')
    .replace(/\\\\b/g, '\\b')
    .replace(/\\\\B/g, '\\B');
}

function normalizedFlags(flags: string): string {
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new UnsafeRegexError('FLAGS_UNSUPPORTED', `Unsupported regular expression flag: ${flag}`);
    }
  }
  return [...new Set(`${flags}u`)].join('');
}

function validatePatternEnvelope(pattern: string, flags: string): string {
  const normalized = normalizeRegexPattern(pattern);
  if (!normalized) throw new UnsafeRegexError('PATTERN_EMPTY', 'Regular expression pattern is empty');
  if (normalized.length > MAX_PATTERN_LENGTH) {
    throw new UnsafeRegexError('PATTERN_TOO_LARGE', 'Regular expression pattern exceeds 4096 characters');
  }
  normalizedFlags(flags);
  return normalized;
}

function repeatedCharacterMinimumRun(normalizedPattern: string): number | undefined {
  const match = /^\(\.\)\\1\{([1-9][0-9]{0,3}),\}$/.exec(normalizedPattern);
  if (!match) return undefined;
  const repeatedCopies = Number(match[1]);
  if (repeatedCopies > MAX_REPEAT_COPIES) {
    throw new UnsafeRegexError(
      'PATTERN_UNSUPPORTED',
      'Repeated-character threshold exceeds the deterministic matcher limit',
    );
  }
  return repeatedCopies + 1;
}

function repeatedCharacterMatches(
  text: string,
  minimumRun: number,
  caseSensitive: boolean,
): Array<{ raw: string; index: number }> {
  const matches: Array<{ raw: string; index: number }> = [];
  let runValue: string | undefined;
  let runStart = 0;
  let runEnd = 0;
  let runLength = 0;

  const collectRun = (): void => {
    if (runValue !== undefined && runLength >= minimumRun && matches.length < MAX_MATCHES) {
      matches.push({ raw: text.slice(runStart, runEnd), index: runStart });
    }
  };

  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const comparable = caseSensitive ? character : character.toLowerCase();
    if (comparable === runValue) {
      runLength += 1;
      runEnd = index + character.length;
    } else {
      collectRun();
      if (matches.length >= MAX_MATCHES) return matches;
      runValue = comparable;
      runStart = index;
      runEnd = index + character.length;
      runLength = 1;
    }
    index += character.length;
  }
  collectRun();
  return matches;
}

export function compileSafeRegex(pattern: string, flags = ''): RE2 {
  const normalized = validatePatternEnvelope(pattern, flags);
  const effectiveFlags = normalizedFlags(flags);
  const cacheKey = `${effectiveFlags}\u0000${normalized}`;
  const cached = compiledCache.get(cacheKey);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  try {
    const compiled = new RE2(normalized, effectiveFlags);
    if (compiledCache.size >= 2_048) {
      const oldest = compiledCache.keys().next().value;
      if (oldest !== undefined) compiledCache.delete(oldest);
    }
    compiledCache.set(cacheKey, compiled);
    return compiled;
  } catch {
    throw new UnsafeRegexError(
      'PATTERN_UNSUPPORTED',
      'Regular expression is invalid or uses constructs unsupported by RE2',
    );
  }
}

export function validateSafeRegexPattern(pattern: string, flags = ''): void {
  const normalized = validatePatternEnvelope(pattern, flags);
  if (repeatedCharacterMinimumRun(normalized) !== undefined) return;
  compileSafeRegex(normalized, flags);
}

export function safeRegexTest(text: string, pattern: string, caseSensitive: boolean): boolean {
  if (text.length > MAX_INPUT_LENGTH) {
    throw new UnsafeRegexError('INPUT_TOO_LARGE', 'Regular expression input exceeds 1048576 characters');
  }
  const flags = caseSensitive ? '' : 'i';
  const normalized = validatePatternEnvelope(pattern, flags);
  const minimumRun = repeatedCharacterMinimumRun(normalized);
  if (minimumRun !== undefined) {
    return repeatedCharacterMatches(text, minimumRun, caseSensitive).length > 0;
  }
  const regex = compileSafeRegex(normalized, flags);
  regex.lastIndex = 0;
  return regex.test(text);
}

export function safeRegexMatches(
  text: string,
  pattern: string,
  caseSensitive: boolean,
): Array<{ raw: string; index: number }> {
  if (text.length > MAX_INPUT_LENGTH) {
    throw new UnsafeRegexError('INPUT_TOO_LARGE', 'Regular expression input exceeds 1048576 characters');
  }
  const flags = caseSensitive ? 'g' : 'gi';
  const normalized = validatePatternEnvelope(pattern, flags);
  const minimumRun = repeatedCharacterMinimumRun(normalized);
  if (minimumRun !== undefined) {
    return repeatedCharacterMatches(text, minimumRun, caseSensitive);
  }
  const regex = compileSafeRegex(normalized, flags);
  const matches: Array<{ raw: string; index: number }> = [];
  regex.lastIndex = 0;
  while (matches.length < MAX_MATCHES) {
    const match = regex.exec(text);
    if (!match) break;
    const raw = match[0] ?? '';
    if (raw) matches.push({ raw, index: match.index });
    if (!raw) regex.lastIndex = Math.min(text.length + 1, regex.lastIndex + 1);
  }
  return matches;
}

export function clearSafeRegexCache(): void {
  compiledCache.clear();
}
