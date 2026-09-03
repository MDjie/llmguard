import { describe, expect, it } from 'vitest';
import { assessGroundedness } from '../../src/lib/rag';

describe('deterministic RAG groundedness gate', () => {
  it('passes claims and numeric facts supported by cited text', () => {
    const result = assessGroundedness({
      output: '该产品保费为100元。保障期限为12个月。',
      citedTexts: ['产品说明：保费为100元，保障期限为12个月。'],
    });
    expect(result.status).toBe('PASS');
    expect(result.unsupportedNumbers).toEqual([]);
  });

  it('fails unsupported numeric facts even when surrounding words overlap', () => {
    const result = assessGroundedness({
      output: '该产品保费为999元。',
      citedTexts: ['产品说明：保费为100元。'],
    });
    expect(result.status).toBe('FAIL');
    expect(result.unsupportedNumbers).toEqual(['999']);
    expect(result.reasonCodes).toContain('RAG_NUMERIC_INCONSISTENCY');
  });

  it('does not claim grounding when citation context is absent', () => {
    expect(assessGroundedness({ output: 'A factual answer.', citedTexts: [] }).status)
      .toBe('INSUFFICIENT_CONTEXT');
  });
});
