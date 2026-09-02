import type { NormalizedView, OriginSpan } from './types';

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/u;
const HTML_ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/giu;
const BASE64_TOKEN = /(?:[A-Za-z0-9+/]{4}){4,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g;
const BASE32_TOKEN = /(?:base32\s*:\s*)?([A-Z2-7]{8,}={0,6})/giu;
const HEX_TOKEN = /(?:[0-9a-f]{2}){4,}/giu;
const QUOTED_PRINTABLE = /(?:=[0-9a-f]{2}){4,}/giu;
const ROT13_PREFIX = /\brot13\s*:\s*([^\r\n]{4,})/giu;
const ESCAPED_CODE_POINT = /\\(?:x([0-9a-f]{2})|u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4}))/giu;
const MAX_VIEWS = 24;
const MAX_DECODE_DEPTH = 3;
const MAX_DECODED_CHARS = 1_048_576;
const CONFUSABLES: Readonly<Record<string, string>> = {
  'Α': 'A', 'А': 'A', 'Β': 'B', 'В': 'B', 'Ε': 'E', 'Е': 'E',
  'Η': 'H', 'Н': 'H', 'Ι': 'I', 'І': 'I', 'Κ': 'K', 'К': 'K',
  'Μ': 'M', 'М': 'M', 'Ν': 'N', 'О': 'O', 'Ο': 'O', 'Ρ': 'P',
  'Р': 'P', 'С': 'C', 'Τ': 'T', 'Т': 'T', 'Χ': 'X', 'Х': 'X',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x',
  'і': 'i', 'ј': 'j', 'ѕ': 's', 'у': 'y',
};

function append(
  textParts: string[],
  spans: OriginSpan[],
  value: string,
  span: OriginSpan,
): void {
  textParts.push(value);
  for (let index = 0; index < value.length; index += 1) spans.push(span);
}

function unicodeView(input: string): NormalizedView {
  const parts: string[] = [];
  const spans: OriginSpan[] = [];
  let offset = 0;
  for (const character of input) {
    const start = offset;
    offset += character.length;
    if (ZERO_WIDTH.test(character)) continue;
    append(parts, spans, character.normalize('NFKC'), { start, end: offset });
  }
  return { id: 'unicode_nfkc', text: parts.join(''), originSpans: spans };
}

function wholeInputView(id: string, text: string, inputLength: number): NormalizedView {
  const bounded = text.slice(0, MAX_DECODED_CHARS);
  return {
    id,
    text: bounded,
    originSpans: Array.from({ length: bounded.length }, () => ({
      start: 0,
      end: inputLength,
    })),
  };
}

function confusableView(input: string): NormalizedView | null {
  const parts: string[] = [];
  const spans: OriginSpan[] = [];
  let changed = false;
  let offset = 0;
  for (const character of input) {
    const start = offset;
    offset += character.length;
    const replacement = CONFUSABLES[character] ?? character;
    if (replacement !== character) changed = true;
    append(parts, spans, replacement, { start, end: offset });
  }
  return changed ? { id: 'confusable_skeleton', text: parts.join(''), originSpans: spans } : null;
}

function decodeHtmlEntity(entity: string): string {
  const lower = entity.toLowerCase();
  if (lower === '&amp;') return '&';
  if (lower === '&lt;') return '<';
  if (lower === '&gt;') return '>';
  if (lower === '&quot;') return '"';
  if (lower === '&apos;') return "'";
  const decimal = lower.match(/^&#(\d+);$/);
  const hexadecimal = lower.match(/^&#x([0-9a-f]+);$/);
  const codePoint = decimal
    ? Number.parseInt(decimal[1], 10)
    : hexadecimal
      ? Number.parseInt(hexadecimal[1], 16)
      : Number.NaN;
  return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : entity;
}

function htmlView(input: string): NormalizedView | null {
  const matches = [...input.matchAll(HTML_ENTITY)];
  if (matches.length === 0) return null;
  const parts: string[] = [];
  const spans: OriginSpan[] = [];
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    append(parts, spans, input.slice(cursor, index), { start: cursor, end: index });
    append(parts, spans, decodeHtmlEntity(match[0]), {
      start: index,
      end: index + match[0].length,
    });
    cursor = index + match[0].length;
  }
  append(parts, spans, input.slice(cursor), { start: cursor, end: input.length });
  return { id: 'html_entity', text: parts.join(''), originSpans: spans };
}

function decodeUrl(input: string): string | null {
  if (!/%[0-9a-f]{2}/iu.test(input)) return null;
  try {
    const decoded = decodeURIComponent(input.replace(/\+/g, '%20'));
    return decoded === input || decoded.length > MAX_DECODED_CHARS ? null : decoded;
  } catch {
    return null;
  }
}

function escapedView(input: string): NormalizedView | null {
  let changed = false;
  const decoded = input.replace(ESCAPED_CODE_POINT, (raw, hexByte, braced, fixed) => {
    const codePoint = Number.parseInt(hexByte ?? braced ?? fixed, 16);
    if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) return raw;
    changed = true;
    return String.fromCodePoint(codePoint);
  });
  return changed ? wholeInputView('escaped_code_points', decoded, input.length) : null;
}

function base64Views(input: string): NormalizedView[] {
  const views: NormalizedView[] = [];
  let sequence = 0;
  for (const match of input.matchAll(BASE64_TOKEN)) {
    if (views.length >= 8) break;
    try {
      const decoded = Buffer.from(match[0], 'base64').toString('utf8');
      const printable = [...decoded].filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code === 9 || code === 10 || code === 13 || code >= 32;
      }).length;
      if (!decoded || printable / [...decoded].length < 0.85) continue;
      const start = match.index ?? 0;
      views.push({
        id: `base64_${sequence++}`,
        text: decoded,
        originSpans: Array.from({ length: decoded.length }, () => ({
          start,
          end: start + match[0].length,
        })),
      });
    } catch {
      // Invalid candidates are simply not materialized as views.
    }
  }
  return views;
}

function hexViews(input: string): NormalizedView[] {
  const views: NormalizedView[] = [];
  let sequence = 0;
  for (const match of input.matchAll(HEX_TOKEN)) {
    if (views.length >= 4) break;
    try {
      const decoded = Buffer.from(match[0], 'hex').toString('utf8');
      if (!decoded || decoded.length > MAX_DECODED_CHARS || decoded.includes('\uFFFD')) continue;
      const printable = [...decoded].filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code === 9 || code === 10 || code === 13 || code >= 32;
      }).length;
      if (printable / [...decoded].length < 0.9) continue;
      const start = match.index ?? 0;
      views.push({
        id: `hex_${sequence++}`,
        text: decoded,
        originSpans: Array.from({ length: decoded.length }, () => ({
          start,
          end: start + match[0].length,
        })),
      });
    } catch {
      // Invalid candidates are not materialized.
    }
  }
  return views;
}

function printableRatio(value: string): number {
  const characters = [...value];
  if (characters.length === 0) return 0;
  return characters.filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || code >= 32;
  }).length / characters.length;
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
      if (bytes.length > MAX_DECODED_CHARS * 4) return null;
    }
  }
  const decoded = Buffer.from(bytes).toString('utf8');
  return !decoded || decoded.includes('\uFFFD') || printableRatio(decoded) < 0.85
    ? null
    : decoded;
}

function base32Views(input: string): NormalizedView[] {
  const views: NormalizedView[] = [];
  let sequence = 0;
  for (const match of input.matchAll(BASE32_TOKEN)) {
    if (views.length >= 4) break;
    const encoded = match[1];
    const decoded = decodeBase32(encoded);
    if (!decoded || decoded.length > MAX_DECODED_CHARS) continue;
    const start = (match.index ?? 0) + match[0].indexOf(encoded);
    views.push({
      id: `base32_${sequence++}`,
      text: decoded,
      originSpans: Array.from({ length: decoded.length }, () => ({
        start,
        end: start + encoded.length,
      })),
    });
  }
  return views;
}

function quotedPrintableView(input: string): NormalizedView | null {
  if (!QUOTED_PRINTABLE.test(input)) return null;
  QUOTED_PRINTABLE.lastIndex = 0;
  const decoded = input.replace(/=([0-9a-f]{2})/giu, (_match, byte: string) =>
    String.fromCharCode(Number.parseInt(byte, 16)));
  return decoded === input || decoded.length > MAX_DECODED_CHARS || printableRatio(decoded) < 0.85
    ? null
    : wholeInputView('quoted_printable', decoded, input.length);
}

function rot13Views(input: string): NormalizedView[] {
  const views: NormalizedView[] = [];
  let sequence = 0;
  for (const match of input.matchAll(ROT13_PREFIX)) {
    if (views.length >= 2) break;
    const value = match[1].replace(/[A-Za-z]/g, (character) => {
      const base = character <= 'Z' ? 65 : 97;
      return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
    });
    views.push(wholeInputView(`rot13_${sequence++}`, value, input.length));
  }
  return views;
}

export function buildNormalizedViews(input: string): readonly NormalizedView[] {
  const original: NormalizedView = {
    id: 'original',
    text: input,
    originSpans: Array.from({ length: input.length }, (_, index) => ({
      start: index,
      end: index + 1,
    })),
  };
  const views: NormalizedView[] = [original, unicodeView(input)];
  const confusable = confusableView(input);
  if (confusable) views.push(confusable);
  const html = htmlView(input);
  if (html) views.push(html);
  let urlCandidate = input;
  for (let depth = 1; depth <= MAX_DECODE_DEPTH; depth += 1) {
    const decoded = decodeUrl(urlCandidate);
    if (!decoded) break;
    views.push(wholeInputView(`url_percent_${depth}`, decoded, input.length));
    urlCandidate = decoded;
  }
  const escaped = escapedView(input);
  if (escaped) views.push(escaped);
  views.push(...base64Views(input));
  for (const encoded of [...views]) {
    if (encoded.id.startsWith('base64_')) {
      views.push(...base64Views(encoded.text).map((view, index) =>
        wholeInputView(`${encoded.id}_nested_${index}`, view.text, input.length)));
    }
  }
  views.push(...hexViews(input));
  views.push(...base32Views(input));
  const quotedPrintable = quotedPrintableView(input);
  if (quotedPrintable) views.push(quotedPrintable);
  views.push(...rot13Views(input));
  const unique = new Map<string, NormalizedView>();
  for (const view of views) {
    if (unique.size >= MAX_VIEWS) break;
    if (![...unique.values()].some((existing) => existing.text === view.text)) {
      unique.set(view.id, view);
    }
  }
  return [...unique.values()];
}

export function mapViewRange(
  view: NormalizedView,
  start: number,
  end: number,
): OriginSpan {
  if (start < 0 || end < start || end > view.text.length) {
    throw new RangeError('normalized view range is invalid');
  }
  if (start === end) {
    const span = view.originSpans[start] ?? view.originSpans[start - 1];
    return span ?? { start: 0, end: 0 };
  }
  const selected = view.originSpans.slice(start, end);
  return {
    start: Math.min(...selected.map((span) => span.start)),
    end: Math.max(...selected.map((span) => span.end)),
  };
}
