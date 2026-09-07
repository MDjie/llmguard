import { evidenceLocationSchema } from '@/contracts/http/multimodal-analysis';

export function validateEvidenceLocation(raw: unknown) {
  const result = evidenceLocationSchema.safeParse(raw);
  return result.success ? { state: 'VERIFIED' as const, location: result.data, reasonCode: null }
    : { state: 'UNVERIFIED' as const, location: null, reasonCode: 'EVIDENCE_LOCATION_UNVERIFIED' };
}

export interface HighlightRange { readonly start: number; readonly end: number; readonly evidenceId: string }
/** The caller must supply the authorized text version. Never reuse original offsets on redacted text. */
export function segmentHighlightedText(text: string, ranges: readonly HighlightRange[]) {
  if (text.length > 262144 || ranges.length > 1000) throw new Error('EVIDENCE_VIEW_BUDGET_EXCEEDED');
  const splitsSurrogate = (offset: number) => offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]);
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > text.length ||
      splitsSurrogate(range.start) || splitsSurrogate(range.end)) throw new Error('EVIDENCE_TEXT_RANGE_INVALID');
  }
  const boundaries = [...new Set([0, text.length, ...ranges.flatMap(range => [range.start, range.end])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, i) => {
    const end = boundaries[i + 1];
    return { start, end, text: text.slice(start, end), evidenceIds: [...new Set(ranges.filter(range => range.start < end && range.end > start).map(range => range.evidenceId))].sort() };
  });
}
