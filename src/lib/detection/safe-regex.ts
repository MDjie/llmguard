import { RE2 } from 're2-wasm';

const MAX_PATTERN_LENGTH = 4_096;
const ALLOWED_FLAGS = new Set(['g', 'i', 'm', 's', 'u']);
const compiledCache = new Map<string, RE2>();

export class UnsafeRegexError extends Error {
  constructor(
    readonly code: 'PATTERN_EMPTY' | 'PATTERN_TOO_LARGE' | 'FLAGS_UNSUPPORTED' | 'PATTERN_UNSUPPORTED',
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

export function compileSafeRegex(pattern: string, flags = ''): RE2 {
  const normalized = normalizeRegexPattern(pattern);
  if (!normalized) throw new UnsafeRegexError('PATTERN_EMPTY', 'Regular expression pattern is empty');
  if (normalized.length > MAX_PATTERN_LENGTH) {
    throw new UnsafeRegexError('PATTERN_TOO_LARGE', 'Regular expression pattern exceeds 4096 characters');
  }
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

export function safeRegexTest(text: string, pattern: string, caseSensitive: boolean): boolean {
  const regex = compileSafeRegex(pattern, caseSensitive ? '' : 'i');
  regex.lastIndex = 0;
  return regex.test(text);
}

export function safeRegexMatches(
  text: string,
  pattern: string,
  caseSensitive: boolean,
): Array<{ raw: string; index: number }> {
  const regex = compileSafeRegex(pattern, caseSensitive ? 'g' : 'gi');
  const matches: Array<{ raw: string; index: number }> = [];
  regex.lastIndex = 0;
  while (matches.length < 10_000) {
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
