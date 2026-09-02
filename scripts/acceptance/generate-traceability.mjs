import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const reportFile = process.argv[2] ?? '输出/大模型安全围栏产品详细需求分析报告_V1.0.md';
const outputFile = process.argv[3] ?? 'acceptance/generated/requirements.json';
const markdownFile = process.argv[4] ?? 'acceptance/generated/traceability.md';
const source = readFileSync(reportFile, 'utf8');
const rules = JSON.parse(readFileSync('acceptance/mapping-rules.json', 'utf8'));
const overrides = JSON.parse(readFileSync('acceptance/requirement-overrides.json', 'utf8'));
const allowedFamilies = new Set(Object.keys(rules));
const rows = [];
for (const line of source.split(/\r?\n/)) {
  const match = /^\|\s*([A-Z]+)-(\d{3})\s*\|\s*(MUST|SHOULD)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(line);
  if (!match || !allowedFamilies.has(match[1])) continue;
  const [, family, number, priority, requirement, acceptanceCriteria] = match;
  const rule = rules[family];
  const index = Math.min(Number(number) - 1, rule.upgradeIds.length - 1);
  const base = {
    id: family + '-' + number,
    family,
    priority,
    requirement: requirement.trim(),
    acceptanceCriteria: acceptanceCriteria.trim(),
    upgradeRequirement: rule.upgradeIds[index],
    designComponent: rule.component,
    implementationStatus: rule.implementationStatus,
    implementation: rule.implementation,
    tests: rule.tests,
    acceptanceStatus: 'PENDING_SIGNED_EVIDENCE',
    evidenceDirectory: 'acceptance/evidence/requirements/' + family + '-' + number
  };
  rows.push({ ...base, ...(overrides[base.id] ?? {}) });
}
const unique = new Set(rows.map((row) => row.id));
if (rows.length !== 101 || unique.size !== 101) {
  throw new Error('Expected exactly 101 unique requirements, found rows=' + rows.length + ', unique=' + unique.size);
}
for (const row of rows) {
  for (const key of ['upgradeRequirement', 'designComponent', 'implementation', 'tests', 'evidenceDirectory']) {
    if (!row[key] || row[key].length === 0) throw new Error(row.id + ' is missing ' + key);
  }
}
const document = {
  schemaVersion: '1.0',
  generatedAt: new Date().toISOString(),
  source: reportFile,
  requirementCount: rows.length,
  policy: 'Implementation mapping is not acceptance. PASS requires immutable signed target-environment evidence. External dependencies are never inferred from orchestration code.',
  requirements: rows
};
mkdirSync(dirname(resolve(outputFile)), { recursive: true });
writeFileSync(outputFile, JSON.stringify(document, null, 2) + '\n');
const markdown = [
  '# GuardLLM 101 requirement traceability',
  '',
  '> Generated from the canonical product requirement report. Code mapping never means acceptance PASS.',
  '',
  '| ID | Priority | Upgrade | Component | Implementation status | Acceptance |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map((row) => '| ' + [
    row.id,
    row.priority,
    row.upgradeRequirement,
    row.designComponent,
    row.implementationStatus,
    row.acceptanceStatus
  ].map((value) => String(value).replace(/\|/g, '\\|')).join(' | ') + ' |'),
  ''
].join('\n');
writeFileSync(markdownFile, markdown);
console.log(JSON.stringify({ requirementCount: rows.length, outputFile, markdownFile }));
