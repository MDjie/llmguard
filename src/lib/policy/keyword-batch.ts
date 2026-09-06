export interface KeywordBatchObject {
  readonly keyword: string;
  readonly score?: number;
  readonly matchType?: 'exact' | 'contains' | 'prefix' | 'suffix';
  readonly caseSensitive?: boolean;
  readonly description?: string;
  readonly tags?: readonly string[];
}

export type KeywordBatchItem = string | KeywordBatchObject;

export type KeywordBatchInsertRow = Record<string, unknown> & {
  readonly policy_id: string;
  readonly category_id: string | null;
  readonly dimension: string;
  readonly keyword: string;
  readonly score: number;
  readonly match_type: 'exact' | 'contains' | 'prefix' | 'suffix';
  readonly case_sensitive: boolean;
  readonly enabled: true;
  readonly description: string;
  readonly tags: readonly string[];
};

export function prepareKeywordCreateRow(input: {
  readonly policyId: string;
  readonly categoryId?: string | null;
  readonly dimension: string;
  readonly item: KeywordBatchObject;
}): KeywordBatchInsertRow {
  return {
    policy_id: input.policyId,
    category_id: input.categoryId ?? null,
    dimension: input.dimension,
    keyword: input.item.keyword,
    score: input.item.score ?? 90,
    match_type: input.item.matchType ?? 'exact',
    case_sensitive: input.item.caseSensitive ?? false,
    enabled: true,
    description: input.item.description ?? '',
    tags: input.item.tags ?? [],
  };
}

export function prepareKeywordBatchRows(input: {
  readonly policyId: string;
  readonly categoryId?: string | null;
  readonly dimension: string;
  readonly keywords: readonly KeywordBatchItem[];
  readonly existingKeywords?: ReadonlySet<string>;
}): { readonly rows: KeywordBatchInsertRow[]; readonly skipped: number } {
  const existingKeywords = input.existingKeywords ?? new Set<string>();
  const requestSeen = new Set<string>();
  const rows: KeywordBatchInsertRow[] = [];
  for (const item of input.keywords) {
    const objectItem = typeof item === 'string' ? null : item;
    const keyword = typeof item === 'string' ? item : item.keyword;
    if (existingKeywords.has(keyword) || requestSeen.has(keyword)) continue;
    requestSeen.add(keyword);
    rows.push(prepareKeywordCreateRow({
      policyId: input.policyId,
      categoryId: input.categoryId,
      dimension: input.dimension,
      item: objectItem ?? { keyword },
    }));
  }
  return { rows, skipped: input.keywords.length - rows.length };
}
