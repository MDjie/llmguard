import { describe, expect, it } from 'vitest';
import {
  developmentCodePointTokenizer,
  planTokenCoverage,
  TokenizerRegistry,
  type ModelTokenizer,
} from '../../src/lib/tokenization';

const digest = ('sha256:' + 'a'.repeat(64)) as `sha256:${string}`;
const exactTokenizer: ModelTokenizer = {
  ...developmentCodePointTokenizer({
    id: 'model-a-tokenizer-v1',
    digest,
    modelIds: ['model-a'],
    maximumInputTokens: 131_072,
  }),
  exact: true,
};

describe('model-aware tokenization and coverage', () => {
  it('requires an exact, pinned tokenizer for acceptance proofs', () => {
    const development = developmentCodePointTokenizer({
      id: 'development-only',
      digest,
      modelIds: ['development-model'],
    });
    expect(() => planTokenCoverage({ text: 'test', tokenizer: development }))
      .toThrow('EXACT_TOKENIZER_REQUIRED');
    expect(planTokenCoverage({
      text: 'test',
      tokenizer: development,
      requireExact: false,
    }).proof.exactTokenizer).toBe(false);
  });

  it('proves complete overlapping coverage for an exact 128K-token input', () => {
    const text = 'a'.repeat(131_072);
    const result = planTokenCoverage({
      text,
      tokenizer: exactTokenizer,
      segmentTokenLimit: 4_096,
      overlapTokens: 256,
    });
    expect(result.proof).toMatchObject({
      totalTokens: 131_072,
      coveredTokens: 131_072,
      coverageRatio: 1,
      uncoveredTokenRanges: [],
      headCovered: true,
      middleCovered: true,
      tailCovered: true,
    });
    expect(result.segments[0].tokenStart).toBe(0);
    expect(result.segments.at(-1)?.tokenEnd).toBe(131_072);
    expect(result.segments.slice(1).every((segment, index) =>
      result.segments[index].tokenEnd - segment.tokenStart === 256,
    )).toBe(true);
  });

  it('binds tokenizer identities to models and rejects ambiguous registration', () => {
    const registry = new TokenizerRegistry();
    registry.register(exactTokenizer);
    expect(registry.resolve({ modelId: 'model-a', requireExact: true })).toBe(exactTokenizer);
    expect(() => registry.resolve({ modelId: 'model-b' })).toThrow('TOKENIZER_NOT_REGISTERED');
    expect(() => registry.register({ ...exactTokenizer, id: 'other' }))
      .toThrow('TOKENIZER_MODEL_DUPLICATE');
  });
});
