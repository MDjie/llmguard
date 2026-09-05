import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const executionDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const reportRoot = path.resolve(
  process.env.P6_FINAL_REPORT_DIRECTORY
    ?? '输出/测试报告/2026-09-05/security-hardening',
);
const summaryPath = path.join(
  reportRoot,
  process.env.P6_FINAL_SUMMARY
    ?? `GuardLLM_安全增强全量验收摘要_V1.0_${executionDate}.json`,
);

function parseCsv(input) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const text = input.replace(/^\uFEFF/u, '');
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell !== ''));
}

const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
const matrixPath = path.join(reportRoot, summary.matrix.file);
const reportPath = path.join(
  reportRoot,
  process.env.P6_FINAL_REPORT
    ?? `GuardLLM_安全检测能力增强_全量验收报告_V1.0_${executionDate}.md`,
);
const [matrix, report] = await Promise.all([
  readFile(matrixPath, 'utf8'),
  readFile(reportPath, 'utf8'),
]);
const rows = parseCsv(matrix);
const headers = rows.shift();
if (!headers) throw new Error('The 158-case matrix is empty');
const index = Object.fromEntries(headers.map((header, position) => [header, position]));
for (const required of ['用例ID', '优先级', '本次结果', '实际结果/偏差', '证据路径', '外部责任人/下一步']) {
  if (index[required] === undefined) throw new Error(`The matrix is missing ${required}`);
}
if (rows.length !== 158) throw new Error(`Expected 158 matrix rows, found ${rows.length}`);
const expectedIds = Array.from({ length: 158 }, (_, position) => `TC-${String(position + 1).padStart(4, '0')}`);
const ids = rows.map((row) => row[index['用例ID']]);
if (ids.some((id, position) => id !== expectedIds[position])) {
  throw new Error('The matrix IDs are not the contiguous TC-0001..TC-0158 sequence');
}
const expectedBlocked = [
  'TC-0122', 'TC-0131', 'TC-0134', 'TC-0135', 'TC-0142',
  'TC-0153', 'TC-0154', 'TC-0155', 'TC-0156', 'TC-0157', 'TC-0158',
];
const blocked = rows
  .filter((row) => row[index['本次结果']] === '外部阻塞')
  .map((row) => row[index['用例ID']]);
if (JSON.stringify(blocked) !== JSON.stringify(expectedBlocked)) {
  throw new Error(`Unexpected external blocker list: ${blocked.join(',')}`);
}
const totals = Object.fromEntries(['通过', '失败', '部分覆盖', '外部阻塞'].map((status) => [
  status,
  rows.filter((row) => row[index['本次结果']] === status).length,
]));
if (totals['通过'] !== 147 || totals['失败'] !== 0 || totals['部分覆盖'] !== 0 || totals['外部阻塞'] !== 11) {
  throw new Error(`Unexpected result totals: ${JSON.stringify(totals)}`);
}
const internalP0P1Failures = rows.filter((row) =>
  ['P0', 'P1'].includes(row[index['优先级']]) && row[index['本次结果']] === '失败',
).length;
if (internalP0P1Failures !== 0) throw new Error('Internal P0/P1 failures remain');
if (rows.some((row) => !row[index['实际结果/偏差']] || !row[index['证据路径']])) {
  throw new Error('At least one matrix row lacks result or evidence');
}

const digest = createHash('sha256').update(matrix).digest('hex');
if (digest !== summary.matrix.sha256) throw new Error('The matrix SHA-256 does not match its summary');
if (summary.status !== 'INTERNAL_PASS_EXTERNAL_SIGNOFF_REQUIRED') {
  throw new Error('The summary does not preserve the external sign-off boundary');
}
if (summary.releaseDecision !== 'HOLD_PRODUCTION_RELEASE') {
  throw new Error('The production release decision must remain HOLD');
}
if (!Number.isInteger(summary.evidenceHygiene?.redactedTestDataCases)
  || summary.evidenceHygiene.redactedTestDataCases < 1) {
  throw new Error('The deliverables do not record controlled test-data redaction');
}
if (!report.includes('| 生产发布 | HOLD；')) {
  throw new Error('The report does not state the production release HOLD decision');
}
if (!report.includes('2000 ATTACK + 2000 BENIGN')) {
  throw new Error('The report omits the independent blind-set requirement');
}
for (const id of expectedBlocked) {
  if (!report.includes(`| ${id} |`)) throw new Error(`The report omits external blocker ${id}`);
}

const combined = `${matrix}\n${JSON.stringify(summary)}\n${report}`;
const sensitivePatterns = [
  /postgres(?:ql)?:\/\/(?!<redacted>)[^\s/@:]+:[^\s/@]+@/iu,
  /(?:E2E_PASSWORD|BOOTSTRAP_ADMIN_PASSWORD|SESSION_SECRET|AUDIT_CHAIN_KEY)\s*[=:]\s*(?!<redacted>)[^\s,;}]+/iu,
  /(?:set-cookie|authorization)\s*:\s*(?!<redacted>)[^\s,;}]+/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|cookie)\s*[=:]\s*(?!\[受控敏感样本已脱敏)[^\s,;}]+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
];
if (sensitivePatterns.some((expression) => expression.test(combined))) {
  throw new Error('A deliverable appears to contain a credential or session secret');
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  matrixRows: rows.length,
  totals,
  internalP0P1Failures,
  blocked,
  matrixSha256: digest,
  redactedTestDataCases: summary.evidenceHygiene.redactedTestDataCases,
})}\n`);
