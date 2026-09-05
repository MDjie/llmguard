import { createHash } from 'node:crypto';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`Invalid argument near ${key ?? '<end>'}`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function fileIdentity(filePath) {
  const [content, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    fileName: path.basename(filePath),
    bytes: metadata.size,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function columnNumber(coordinate) {
  const letters = coordinate.match(/^[A-Z]+/)?.[0] ?? '';
  return [...letters].reduce(
    (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
    0,
  );
}

function rowNumber(coordinate) {
  return Number(coordinate.match(/\d+$/)?.[0] ?? 0);
}

function extractCaseIds(sheet) {
  const ids = [];
  for (const cell of sheet.cells) {
    if (columnNumber(cell.coordinate) !== 1 || rowNumber(cell.coordinate) < 5) continue;
    const value = String(cell.cached_value ?? cell.value ?? '');
    if (/^TC-\d{4}$/.test(value)) ids.push(value);
  }
  return ids;
}

const args = parseArgs(process.argv.slice(2));
const required = ['inventory', 'docx', 'xlsx', 'output'];
for (const key of required) {
  if (!args.has(key)) throw new Error(`Missing --${key}`);
}

const inventoryPath = path.resolve(args.get('inventory'));
const docxPath = path.resolve(args.get('docx'));
const xlsxPath = path.resolve(args.get('xlsx'));
const outputPath = path.resolve(args.get('output'));
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
const testCaseSheet = inventory.xlsx?.sheets?.find((sheet) => sheet.name === '测试用例');
if (!testCaseSheet) throw new Error('The 测试用例 sheet is missing');

const caseIds = extractCaseIds(testCaseSheet);
const expectedIds = Array.from(
  { length: 158 },
  (_, index) => `TC-${String(index + 1).padStart(4, '0')}`,
);
const uniqueIds = [...new Set(caseIds)];
const missingIds = expectedIds.filter((id) => !uniqueIds.includes(id));
const unexpectedIds = uniqueIds.filter((id) => !expectedIds.includes(id));
const duplicateIds = uniqueIds.filter((id) => caseIds.filter((candidate) => candidate === id).length > 1);

const output = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  status: caseIds.length === 158
    && uniqueIds.length === 158
    && missingIds.length === 0
    && unexpectedIds.length === 0
    && duplicateIds.length === 0
    ? 'PASS'
    : 'FAIL',
  sources: {
    docx: await fileIdentity(docxPath),
    xlsx: await fileIdentity(xlsxPath),
    extractedInventory: await fileIdentity(inventoryPath),
  },
  docxStructure: {
    paragraphs: inventory.docx?.paragraph_count ?? null,
    tables: inventory.docx?.table_count ?? null,
    inlineShapes: inventory.docx?.inline_shape_count ?? null,
    sections: inventory.docx?.section_count ?? null,
  },
  workbookStructure: (inventory.xlsx?.sheets ?? []).map((sheet) => ({
    name: sheet.name,
    state: sheet.state,
    rows: sheet.max_row,
    columns: sheet.max_column,
    nonemptyCells: sheet.cells.length,
  })),
  testCases: {
    expected: 158,
    discovered: caseIds.length,
    unique: uniqueIds.length,
    first: caseIds.at(0) ?? null,
    last: caseIds.at(-1) ?? null,
    missingIds,
    unexpectedIds,
    duplicateIds,
  },
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ status: output.status, testCases: output.testCases }));
if (output.status !== 'PASS') process.exitCode = 1;
