import { describe, expect, it } from 'vitest';
import { parseKeywordBatchText } from '../../src/lib/policy/keyword-batch-parser';
import { batchKeywordSchema } from '../../src/contracts/http/policies';

describe('guardrail keyword batch import boundary', () => {
  it('preserves an explicit zero score and defaults only a missing score', () => {
    const parsed = parseKeywordBatchText('candidate only,0,shadow review\ndefault score,,review');
    expect(parsed.issues).toEqual([]);
    expect(parsed.items).toEqual([
      { keyword: 'candidate only', score: 0, description: 'shadow review' },
      { keyword: 'default score', score: 90, description: 'review' },
    ]);
    expect(batchKeywordSchema.parse({ keywords: parsed.items, dimension: 'prompt_injection' }).keywords).toHaveLength(2);
  });

  it('supports quoted commas, escaped quotes, CRLF, multiline descriptions and Unicode', () => {
    const parsed = parseKeywordBatchText('"中文,关键词",30,"说明"\r\n"quoted ""term""",40,"line 1\nline 2"');
    expect(parsed.issues).toEqual([]);
    expect(parsed.items).toEqual([
      { keyword: '中文,关键词', score: 30, description: '说明' },
      { keyword: 'quoted "term"', score: 40, description: 'line 1\nline 2' },
    ]);
  });

  it.each(['-1', '101', '1.5', 'zero', '00'])('rejects invalid score %s', (score) => {
    expect(parseKeywordBatchText(`term,${score},description`).issues[0]?.code).toBe('SCORE_INVALID');
  });

  it('rejects JSON/JSONL and malformed CSV instead of silently importing at score 90', () => {
    expect(parseKeywordBatchText('{"keyword":"attack","score":0}').issues[0]?.code).toBe('FORMAT_UNSUPPORTED');
    expect(parseKeywordBatchText('"unclosed,20').issues[0]?.code).toBe('CSV_INVALID');
  });

  it('deduplicates the request deterministically', () => {
    const parsed = parseKeywordBatchText('same,20,first\nsame,90,second');
    expect(parsed.items).toEqual([{ keyword: 'same', score: 20, description: 'first' }]);
    expect(parsed.duplicateRows).toBe(1);
  });
});
