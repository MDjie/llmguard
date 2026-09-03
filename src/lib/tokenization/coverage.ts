import { createHash } from 'node:crypto';
import type {
  ModelTokenizer,
  TokenCoveragePlan,
  TokenOffset,
  TokenSegment,
} from './types';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateTokens(text: string, tokens: readonly TokenOffset[]): void {
  let previousStart = 0;
  for (const token of tokens) {
    if (
      !Number.isSafeInteger(token.tokenId)
      || !Number.isSafeInteger(token.start)
      || !Number.isSafeInteger(token.end)
      || token.start < previousStart
      || token.start < 0
      || token.end <= token.start
      || token.end > text.length
    ) {
      throw new Error('TOKENIZER_OFFSETS_INVALID');
    }
    previousStart = token.start;
  }
  if (text.length > 0 && tokens.length === 0) throw new Error('TOKENIZER_EMPTY_RESULT');
}

function uncoveredRanges(covered: readonly boolean[]): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let start: number | undefined;
  for (let index = 0; index <= covered.length; index += 1) {
    if (index < covered.length && !covered[index] && start === undefined) start = index;
    if ((index === covered.length || covered[index]) && start !== undefined) {
      ranges.push([start, index]);
      start = undefined;
    }
  }
  return ranges;
}

export function planTokenCoverage(input: {
  readonly text: string;
  readonly tokenizer: ModelTokenizer;
  readonly segmentTokenLimit?: number;
  readonly overlapTokens?: number;
  readonly requireExact?: boolean;
}): TokenCoveragePlan {
  if (input.requireExact !== false && !input.tokenizer.exact) {
    throw new Error('EXACT_TOKENIZER_REQUIRED');
  }
  const segmentTokenLimit = input.segmentTokenLimit ?? 4_096;
  const overlapTokens = input.overlapTokens ?? 256;
  if (
    !Number.isSafeInteger(segmentTokenLimit)
    || segmentTokenLimit <= 0
    || segmentTokenLimit > input.tokenizer.maximumInputTokens
    || !Number.isSafeInteger(overlapTokens)
    || overlapTokens < 0
    || overlapTokens >= segmentTokenLimit
  ) {
    throw new Error('TOKEN_SEGMENT_CONFIGURATION_INVALID');
  }
  const tokens = [...input.tokenizer.encodeWithOffsets(input.text)];
  validateTokens(input.text, tokens);
  if (tokens.length > input.tokenizer.maximumInputTokens) {
    throw new Error('MODEL_INPUT_TOKEN_LIMIT_EXCEEDED');
  }
  const covered = Array.from({ length: tokens.length }, () => false);
  const segments: TokenSegment[] = [];
  const step = segmentTokenLimit - overlapTokens;
  for (let tokenStart = 0; tokenStart < tokens.length; tokenStart += step) {
    const tokenEnd = Math.min(tokens.length, tokenStart + segmentTokenLimit);
    for (let token = tokenStart; token < tokenEnd; token += 1) covered[token] = true;
    const midpoint = tokens.length / 2;
    segments.push({
      index: segments.length,
      tokenStart,
      tokenEnd,
      charStart: tokens[tokenStart].start,
      charEnd: tokens[tokenEnd - 1].end,
      isHead: tokenStart === 0,
      isMiddle: tokenStart <= midpoint && tokenEnd >= midpoint,
      isTail: tokenEnd === tokens.length,
    });
    if (tokenEnd === tokens.length) break;
  }
  const uncoveredTokenRanges = uncoveredRanges(covered);
  const coveredTokens = covered.filter(Boolean).length;
  const coverageRatio = tokens.length === 0 ? 1 : coveredTokens / tokens.length;
  const segmentsDigest = sha256(JSON.stringify(segments));
  return {
    tokens,
    segments,
    proof: {
      proofVersion: '1.0',
      tokenizerId: input.tokenizer.id,
      tokenizerDigest: input.tokenizer.digest,
      exactTokenizer: input.tokenizer.exact,
      contentSha256: sha256(input.text),
      totalTokens: tokens.length,
      coveredTokens,
      coverageRatio,
      uncoveredTokenRanges,
      headCovered: tokens.length === 0 || covered[0],
      middleCovered: tokens.length === 0 || covered[Math.floor((tokens.length - 1) / 2)],
      tailCovered: tokens.length === 0 || covered[tokens.length - 1],
      segmentTokenLimit,
      overlapTokens,
      segmentsDigest,
    },
  };
}
