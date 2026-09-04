import { describe, expect, it } from 'vitest';
import {
  compileSafeRegex,
  safeRegexMatches,
  safeRegexTest,
  UnsafeRegexError,
  validateSafeRegexPattern,
} from '../../src/lib/detection/safe-regex';

const repeatedCharacterPattern = String.raw`(.)\1{8,}`;

describe('deterministic repeated-character policy pattern', () => {
  it('evaluates the exact legacy repetition grammar with a linear scan', () => {
    expect(() => compileSafeRegex(repeatedCharacterPattern)).toThrow(UnsafeRegexError);
    expect(() => validateSafeRegexPattern(repeatedCharacterPattern, 'i')).not.toThrow();
    expect(safeRegexMatches('ab!!!!!!!!!!cd', repeatedCharacterPattern, false)).toEqual([
      { raw: '!!!!!!!!!!', index: 2 },
    ]);
    expect(safeRegexTest('x😀😀😀😀😀😀😀😀😀y', repeatedCharacterPattern, true)).toBe(true);
    expect(safeRegexTest('x!!!!!!!!y', repeatedCharacterPattern, true)).toBe(false);
    expect(safeRegexTest('xAaaaaaaaay', repeatedCharacterPattern, false)).toBe(true);
  });

  it('continues to reject every other unsupported backreference or lookaround', () => {
    expect(() => validateSafeRegexPattern(String.raw`(a)\1`)).toThrow(UnsafeRegexError);
    expect(() => validateSafeRegexPattern('a(?=b)')).toThrow(UnsafeRegexError);
    expect(() => validateSafeRegexPattern(String.raw`(.)\1{99999,}`)).toThrow(UnsafeRegexError);
  });
});
