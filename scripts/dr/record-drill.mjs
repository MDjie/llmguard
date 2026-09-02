import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [inputFile, outputRoot = 'acceptance/evidence/dr'] = process.argv.slice(2);
if (!inputFile) throw new Error('Usage: node scripts/dr/record-drill.mjs <drill-input.json> [output-root]');
const input = JSON.parse(readFileSync(inputFile, 'utf8'));
const required = ['drillId', 'environment', 'failureAt', 'lastDurableDataAt', 'serviceRecoveredAt', 'approver'];
for (const key of required) if (!input[key]) throw new Error('Missing drill field: ' + key);
const failureAt = Date.parse(input.failureAt);
const durableAt = Date.parse(input.lastDurableDataAt);
const recoveredAt = Date.parse(input.serviceRecoveredAt);
if (![failureAt, durableAt, recoveredAt].every(Number.isFinite)) throw new Error('Drill timestamps must be ISO-8601');
const rpoMinutes = Math.max(0, (failureAt - durableAt) / 60_000);
const rtoMinutes = Math.max(0, (recoveredAt - failureAt) / 60_000);
const report = {
  schemaVersion: '1.0',
  source: basename(inputFile),
  recordedAt: new Date().toISOString(),
  ...input,
  measurements: { rpoMinutes, rtoMinutes },
  targets: { rpoMinutes: 15, rtoMinutes: 30 },
  status: rpoMinutes <= 15 && rtoMinutes <= 30 ? 'PASS' : 'FAIL',
};
const canonical = JSON.stringify(report, null, 2) + '\n';
const digest = createHash('sha256').update(canonical).digest('hex');
const directory = resolve(outputRoot, input.drillId + '-' + Date.now());
mkdirSync(directory, { recursive: false });
writeFileSync(join(directory, 'report.json'), canonical, { flag: 'wx' });
writeFileSync(join(directory, 'SHA256'), digest + '  report.json\n', { flag: 'wx' });
console.log(JSON.stringify({ directory, digest, status: report.status, rpoMinutes, rtoMinutes }));
if (report.status !== 'PASS') process.exitCode = 1;
