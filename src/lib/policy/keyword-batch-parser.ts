export interface ParsedKeywordBatchItem {
  readonly keyword: string;
  readonly score: number;
  readonly description: string;
}

export interface KeywordBatchParseIssue {
  readonly row: number;
  readonly code: 'CSV_INVALID' | 'FORMAT_UNSUPPORTED' | 'KEYWORD_REQUIRED' | 'KEYWORD_TOO_LONG' | 'SCORE_INVALID' | 'DESCRIPTION_TOO_LONG' | 'ROW_LIMIT_EXCEEDED';
  readonly message: string;
}

export interface KeywordBatchParseResult {
  readonly items: readonly ParsedKeywordBatchItem[];
  readonly issues: readonly KeywordBatchParseIssue[];
  readonly duplicateRows: number;
}

interface CsvParseResult {
  readonly rows: readonly (readonly string[])[];
  readonly issue?: KeywordBatchParseIssue;
}

function csvRows(input: string): CsvParseResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let justClosedQuote = false;
  let rowNumber = 1;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; justClosedQuote = true; }
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field.length > 0 || justClosedQuote) return { rows, issue: { row: rowNumber, code: 'CSV_INVALID', message: `第 ${rowNumber} 行引号位置无效` } };
      quoted = true;
      continue;
    }
    if (justClosedQuote && char !== ',' && char !== '\r' && char !== '\n' && !/\s/u.test(char)) {
      return { rows, issue: { row: rowNumber, code: 'CSV_INVALID', message: `第 ${rowNumber} 行引号后存在无效字符` } };
    }
    if (char === ',') { row.push(field); field = ''; justClosedQuote = false; continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = ''; justClosedQuote = false; rowNumber += 1; continue;
    }
    field += char;
  }
  if (quoted) return { rows, issue: { row: rowNumber, code: 'CSV_INVALID', message: `第 ${rowNumber} 行引号未闭合` } };
  row.push(field);
  rows.push(row);
  return { rows };
}

export function parseKeywordBatchText(input: string, maxRows = 5_000): KeywordBatchParseResult {
  const trimmed = input.trim();
  if (/^[{[]/u.test(trimmed)) return { items: [], duplicateRows: 0, issues: [{ row: 1, code: 'FORMAT_UNSUPPORTED', message: '批量导入仅接受 CSV 文本，不接受 JSON 或 JSONL' }] };
  const parsed = csvRows(input);
  if (parsed.issue) return { items: [], duplicateRows: 0, issues: [parsed.issue] };
  const nonEmptyRows = parsed.rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (nonEmptyRows.length > maxRows) return { items: [], duplicateRows: 0, issues: [{ row: maxRows + 1, code: 'ROW_LIMIT_EXCEEDED', message: `最多允许 ${maxRows} 条关键词` }] };
  const items: ParsedKeywordBatchItem[] = [];
  const issues: KeywordBatchParseIssue[] = [];
  const seen = new Set<string>();
  let duplicateRows = 0;
  nonEmptyRows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (row.length > 3) { issues.push({ row: rowNumber, code: 'CSV_INVALID', message: `第 ${rowNumber} 行最多包含关键词、分数、描述三列` }); return; }
    const keyword = (row[0] ?? '').trim();
    const scoreText = (row[1] ?? '').trim();
    const description = (row[2] ?? '').trim();
    if (!keyword) { issues.push({ row: rowNumber, code: 'KEYWORD_REQUIRED', message: `第 ${rowNumber} 行关键词不能为空` }); return; }
    if (keyword.length > 512) { issues.push({ row: rowNumber, code: 'KEYWORD_TOO_LONG', message: `第 ${rowNumber} 行关键词超过 512 字符` }); return; }
    if (description.length > 2_000) { issues.push({ row: rowNumber, code: 'DESCRIPTION_TOO_LONG', message: `第 ${rowNumber} 行描述超过 2000 字符` }); return; }
    if (scoreText && !/^(?:0|[1-9]\d?|100)$/u.test(scoreText)) { issues.push({ row: rowNumber, code: 'SCORE_INVALID', message: `第 ${rowNumber} 行分数必须是 0 到 100 的整数` }); return; }
    if (seen.has(keyword)) { duplicateRows += 1; return; }
    seen.add(keyword);
    items.push({ keyword, score: scoreText ? Number(scoreText) : 90, description });
  });
  return { items, issues, duplicateRows };
}
