import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:58082').replace(/\/$/, '');
const username = process.env.E2E_USERNAME;
const password = process.env.E2E_PASSWORD;
const inventoryPath = process.env.ATTACHMENT_INVENTORY
  ?? path.resolve('输出/测试报告/2026-09-04/source-inventory.json');
const outputPath = process.env.ATTACHMENT_API_RESULTS
  ?? path.resolve('输出/测试报告/2026-09-04/runtime-api-results.json');

if (!username || !password) {
  throw new Error('E2E_USERNAME and E2E_PASSWORD are required');
}

const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
const testCaseSheet = inventory.xlsx.sheets.find((sheet) => sheet.name === '测试用例');
if (!testCaseSheet) throw new Error('测试用例 sheet is missing from the extracted inventory');

function columnNumber(coordinate) {
  const letters = coordinate.match(/^[A-Z]+/)?.[0] ?? '';
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function rowNumber(coordinate) {
  return Number(coordinate.match(/\d+$/)?.[0] ?? 0);
}

function rowsFromSheet(sheet) {
  const rows = new Map();
  for (const cell of sheet.cells) {
    const row = rowNumber(cell.coordinate);
    const column = columnNumber(cell.coordinate);
    const values = rows.get(row) ?? new Map();
    values.set(column, cell.cached_value ?? cell.value ?? '');
    rows.set(row, values);
  }
  return rows;
}

const rows = rowsFromSheet(testCaseSheet);
const cases = [];
for (let row = 5; row <= testCaseSheet.max_row; row += 1) {
  const values = rows.get(row);
  if (!values || !String(values.get(1) ?? '').startsWith('TC-')) continue;
  cases.push({
    id: String(values.get(1)),
    module: String(values.get(3) ?? ''),
    title: String(values.get(4) ?? ''),
    sample: String(values.get(10) ?? ''),
    expected: String(values.get(11) ?? ''),
    baseline: String(values.get(13) ?? ''),
  });
}

const runtimeCases = cases.filter((testCase) =>
  testCase.module === '16维检测'
  && testCase.sample
  && testCase.sample !== '见测试数据表');

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: baseUrl,
  },
  body: JSON.stringify({ username, password, rememberMe: false }),
});
const loginBody = await loginResponse.json().catch(() => null);
if (!loginResponse.ok) {
  throw new Error(`Login failed (${loginResponse.status}): ${JSON.stringify(loginBody)}`);
}

const setCookies = typeof loginResponse.headers.getSetCookie === 'function'
  ? loginResponse.headers.getSetCookie()
  : [loginResponse.headers.get('set-cookie')].filter(Boolean);
const cookies = new Map();
for (const header of setCookies) {
  const pair = header.split(';', 1)[0];
  const separator = pair.indexOf('=');
  if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
}
const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
const csrfToken = decodeURIComponent(cookies.get('csrf-token') ?? '');
if (!cookieHeader || !csrfToken) throw new Error('Session or CSRF cookie was not issued');

const results = [];
for (const testCase of runtimeCases) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/detect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
      origin: baseUrl,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({ text: testCase.sample, direction: 'input' }),
  });
  const body = await response.json().catch(() => null);
  const expectedDimension = testCase.expected.match(/(?:命中|不因)\s*([a-z_]+)/)?.[1] ?? null;
  const findings = Array.isArray(body?.data?.findings) ? body.data.findings : [];
  const matchedExpectedDimension = expectedDimension
    ? findings.some((finding) => finding?.dimension === expectedDimension)
    : null;
  const isNegative = testCase.title.includes('反例');
  const assertionPassed = response.ok
    && (isNegative
      ? body?.data?.action !== 'block' && !matchedExpectedDimension
      : matchedExpectedDimension === true && body?.data?.action !== 'allow');

  results.push({
    caseId: testCase.id,
    module: testCase.module,
    title: testCase.title,
    baseline: testCase.baseline,
    inputSha256: createHash('sha256').update(testCase.sample).digest('hex'),
    expectedDimension,
    isNegative,
    httpStatus: response.status,
    action: body?.data?.action ?? null,
    overallScore: body?.data?.overallScore ?? null,
    confidence: body?.data?.confidence ?? null,
    findingDimensions: findings.map((finding) => finding?.dimension).filter(Boolean),
    matchedExpectedDimension,
    assertionPassed,
    latencyMs: Date.now() - startedAt,
    problemCode: response.ok ? null : body?.code ?? null,
  });
}

const anonymousDetect = await fetch(`${baseUrl}/api/detect`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: baseUrl },
  body: JSON.stringify({ text: 'anonymous boundary probe', direction: 'input' }),
});
const anonymousBody = await anonymousDetect.json().catch(() => null);

const output = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  source: inventoryPath,
  principal: { username: loginBody?.user?.username ?? username, role: loginBody?.user?.role ?? null },
  summary: {
    selectedCases: runtimeCases.length,
    passedAssertions: results.filter((result) => result.assertionPassed).length,
    failedAssertions: results.filter((result) => !result.assertionPassed).length,
    httpSuccesses: results.filter((result) => result.httpStatus === 200).length,
    anonymousBoundaryPassed: anonymousDetect.status === 401
      && anonymousBody?.code === 'AUTHENTICATION_REQUIRED',
  },
  anonymousBoundary: {
    httpStatus: anonymousDetect.status,
    code: anonymousBody?.code ?? null,
  },
  results,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(output.summary));
