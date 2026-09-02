import { describe, expect, it } from 'vitest';
import {
  compileSafeRegex,
  safeRegexMatches,
  safeRegexTest,
  UnsafeRegexError,
} from '../../src/lib/detection/safe-regex';

describe('RE2-backed policy patterns', () => {
  it('matches supported Unicode patterns and preserves offsets', () => {
    expect(safeRegexTest('账号 13800138000', String.raw`1[3-9]\d{9}`, false)).toBe(true);
    expect(safeRegexMatches('a风险b风险', '风险', false)).toEqual([
      { raw: '风险', index: 1 },
      { raw: '风险', index: 4 },
    ]);
  });

  it('evaluates a catastrophic-backtracking pattern with RE2 semantics', () => {
    const input = `${'a'.repeat(20_000)}!`;
    expect(safeRegexTest(input, '(a+)+$', true)).toBe(false);
  });

  it('rejects unsupported backreferences and lookahead during compilation', () => {
    expect(() => compileSafeRegex(String.raw`(a)\1`)).toThrow(UnsafeRegexError);
    expect(() => compileSafeRegex('a(?=b)')).toThrow(UnsafeRegexError);
  });

  it('bounds untrusted pattern length', () => {
    expect(() => compileSafeRegex('a'.repeat(4_097))).toThrowError(
      expect.objectContaining({ code: 'PATTERN_TOO_LARGE' }),
    );
  });
});
