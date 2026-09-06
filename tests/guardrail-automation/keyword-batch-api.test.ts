import { describe, expect, it } from 'vitest';
import { prepareKeywordBatchRows, prepareKeywordCreateRow } from '../../src/lib/policy/keyword-batch';

describe('keyword batch API row preparation', () => {
  it('preserves explicit zero, applies defaults, and deduplicates one request', () => {
    const result = prepareKeywordBatchRows({
      policyId: 'policy-a',
      categoryId: null,
      dimension: 'prompt_injection',
      existingKeywords: new Set(['already exists']),
      keywords: [
        { keyword: 'zero score', score: 0, matchType: 'contains', caseSensitive: true },
        { keyword: 'default score' },
        'already exists',
        'zero score',
      ],
    });
    expect(result.skipped).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ keyword: 'zero score', score: 0, match_type: 'contains', case_sensitive: true });
    expect(result.rows[1]).toMatchObject({ keyword: 'default score', score: 90, match_type: 'exact', case_sensitive: false });
  });

  it('preserves an explicit zero for the single-keyword API row', () => {
    expect(prepareKeywordCreateRow({
      policyId: 'policy-a',
      dimension: 'prompt_injection',
      item: { keyword: 'zero score', score: 0 },
    })).toMatchObject({keyword:'zero score',score:0,category_id:null});
  });
});
